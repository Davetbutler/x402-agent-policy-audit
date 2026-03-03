/**
 * PolicyAwareX402Client wraps the real @x402/fetch client with APL policy evaluation.
 * Uses x402Client.onBeforePaymentCreation to evaluate every payment against the bound
 * policy before the scheme signs. On deny/escalate the hook aborts; on permit the
 * flow continues and we record budget in onAfterPaymentCreation.
 */

import { v4 as uuidv4 } from "uuid";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import type { Policy, EvaluationRequest, EvaluationResponse } from "../policy/schema.js";
import { evaluate } from "../policy/engine.js";
import { BudgetTracker } from "../policy/budget-tracker.js";
import { AuditLogger } from "../audit/logger.js";
import { PolicyDeniedError, PolicyEscalationError } from "./policy-action-provider.js";

// Re-export for consumers that don't use the real x402 flow
export interface PaymentRequired {
  amount: number;
  currency: string;
  recipient: string;
  network: string;
  description?: string;
}

export interface PolicyAwareX402Config {
  policy: Policy;
  budgetTracker: BudgetTracker;
  auditLogger: AuditLogger;
  /** EVM signer (e.g. from viem privateKeyToAccount) for ExactEvmScheme */
  signer: ClientEvmSigner;
  /** Optional network list; default is eip155:* (all EVM) */
  networks?: string[];
  /** Optional: called with progress messages for verbose demo output */
  log?: (message: string) => void;
}

/**
 * Infer merchant category from description for APL evaluation.
 */
function inferCategory(description: string): string {
  const d = description.toLowerCase();
  if (d.includes("flight") || d.includes("airline")) return "flights";
  if (d.includes("hotel") || d.includes("lodging")) return "hotels";
  if (d.includes("transport") || d.includes("taxi") || d.includes("uber"))
    return "ground_transport";
  return "uncategorized";
}

/**
 * Build a policy-aware x402 fetch function. On 402 responses, the client runs APL
 * evaluation in onBeforePaymentCreation; if the policy denies or requires escalation,
 * payment creation is aborted. If permitted, the registered ExactEvmScheme signs
 * and the request is retried with the payment header.
 */
/**
 * Build a short "why permitted" summary for verbose logging (policy + budget context).
 */
function permitReasons(
  policy: Policy,
  amount: number,
  category: string,
  budgetBefore: { remaining: number; totalBudget: number; spent: number }
): string[] {
  const reasons: string[] = [];
  const totalCents = policy.budget.total;
  const perTxCents = policy.budget.per_transaction ?? totalCents;
  reasons.push(`amount ${amount} within total budget (remaining: ${budgetBefore.remaining} / ${budgetBefore.totalBudget})`);
  reasons.push(`amount within per-transaction limit (${perTxCents})`);
  reasons.push(`category "${category}" allowed for payment`);
  reasons.push("within policy validity period");
  return reasons;
}

export function createPolicyAwareX402Fetch(
  config: PolicyAwareX402Config,
  baseFetch: typeof fetch = fetch
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const { policy, budgetTracker, auditLogger, signer, networks, log } = config;

  budgetTracker.init(policy.id, policy.budget.total);

  const client = new x402Client();
  registerExactEvmScheme(client, { signer, networks: networks as never[] });

  client.onBeforePaymentCreation(async (ctx) => {
    const { paymentRequired, selectedRequirements } = ctx;
    const req = selectedRequirements;
    const amount = Number(req.amount);
    const description = paymentRequired.resource?.description ?? "";
    const url = paymentRequired.resource?.url ?? "";
    const category = inferCategory(description);

    if (log) {
      log("Received 402 Payment Required.");
      log(`  Resource: ${url}`);
      log(`  Amount: ${amount} (smallest units), category: "${category}"`);
      log("Checking policy...");
    }

    const request: EvaluationRequest = {
      apl_version: "0.1",
      request_id: `req_${uuidv4().slice(0, 8)}`,
      policy_id: policy.id,
      timestamp: new Date().toISOString(),
      action: {
        type: "payment",
        amount,
        currency: "USD",
        recipient: {
          id: req.payTo,
          category,
        },
        metadata: {
          url,
          network: req.network,
          ...(description ? { description } : {}),
        },
      },
      context: {
        agent_id: policy.agent.id,
      },
    };

    const budgetBefore = budgetTracker.getState(policy.id);
    if (log) {
      log(`  Budget state: spent ${budgetBefore.spent}, remaining ${budgetBefore.remaining} of ${budgetBefore.totalBudget}`);
    }

    const start = performance.now();
    const response = evaluate(policy, budgetBefore, request);
    const durationMs = Math.round(performance.now() - start);

    const budgetAfter =
      response.decision === "permit"
        ? { ...budgetBefore, spent: budgetBefore.spent + amount, remaining: budgetBefore.remaining - amount }
        : budgetBefore;

    auditLogger.emit(policy, request, response, budgetBefore, budgetAfter, durationMs);

    if (log) {
      if (response.decision === "permit") {
        const reasons = permitReasons(policy, amount, category, budgetBefore);
        log("Policy passed.");
        reasons.forEach((r) => log(`  ✓ ${r}`));
        log("Creating signed payment (EIP-3009) and retrying request with PAYMENT-SIGNATURE header...");
      } else if (response.decision === "deny" || response.decision === "deny_with_reason") {
        log(`Policy denied: ${response.denial?.code ?? "unknown"} — ${response.denial?.message ?? ""}`);
      } else {
        log("Policy requires escalation (amount or condition above approval threshold).");
      }
    }

    if (response.decision === "permit") {
      return;
    }
    if (response.decision === "escalate") {
      throw new PolicyEscalationError(response);
    }
    throw new PolicyDeniedError(response);
  });

  client.onAfterPaymentCreation(async (ctx) => {
    const { selectedRequirements } = ctx;
    const amount = Number(selectedRequirements.amount);
    budgetTracker.record(policy.id, amount);
    if (log) {
      log("Payment recorded; budget updated.");
    }
  });

  return wrapFetchWithPayment(baseFetch, client);
}

/**
 * Policy-aware x402 client that holds config and exposes fetch.
 * Use createPolicyAwareX402Fetch for a one-shot wrapped fetch, or this class
 * when you need to keep a reference and pass the same client around.
 */
export class PolicyAwareX402Client {
  private readonly wrappedFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  constructor(config: PolicyAwareX402Config, baseFetch: typeof fetch = fetch) {
    this.wrappedFetch = createPolicyAwareX402Fetch(config, baseFetch);
  }

  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    return this.wrappedFetch(url, init);
  }
}

// Re-export errors for consumers
export { PolicyDeniedError, PolicyEscalationError };
