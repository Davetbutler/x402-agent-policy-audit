/**
 * PolicyAwareX402Client wraps the real @x402/fetch client with APL policy evaluation
 * via a remote policy server. On 402 responses, it calls the policy server to evaluate
 * the payment; on permit the flow continues, on deny/escalate it aborts.
 */

import { v4 as uuidv4 } from "uuid";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import type { Policy, EvaluationRequest } from "../policy/schema.js";
import { PolicyClient } from "../client/policy-client.js";
import { PolicyDeniedError, PolicyEscalationError } from "./policy-action-provider.js";

export interface PaymentRequired {
  amount: number;
  currency: string;
  recipient: string;
  network: string;
  description?: string;
}

export interface PolicyAwareX402Config {
  policy: Policy;
  policyClient: PolicyClient;
  signer: ClientEvmSigner;
  /** Wallet address of the signer; must be in policy.wallets. */
  walletAddress: string;
  networks?: string[];
  log?: (message: string) => void;
}

function permitReasons(
  policy: Policy,
  amount: number,
  result: { remaining_budget?: number }
): string[] {
  const reasons: string[] = [];
  reasons.push(`amount ${amount} within total budget (remaining: ${result.remaining_budget ?? "unknown"})`);
  reasons.push(`amount within max without approval (${policy.max_without_approval})`);
  reasons.push("action type payment allowed");
  reasons.push("within policy validity period");
  return reasons;
}

export function createPolicyAwareX402Fetch(
  config: PolicyAwareX402Config,
  baseFetch: typeof fetch = fetch
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const { policy, policyClient, signer, walletAddress, networks, log } = config;

  const client = new x402Client();
  registerExactEvmScheme(client, { signer, networks: networks as never[] });

  client.onBeforePaymentCreation(async (ctx) => {
    const { paymentRequired, selectedRequirements } = ctx;
    const req = selectedRequirements;
    const amount = Number(req.amount);
    const url = paymentRequired.resource?.url ?? "";

    if (log) {
      log("Received 402 Payment Required.");
      log(`  Resource: ${url}`);
      log(`  Amount: ${amount} (smallest units)`);
      log("Checking policy (remote server)...");
    }

    const evalRequest: EvaluationRequest = {
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
        },
        metadata: {
          url,
          network: req.network,
        },
      },
      context: {
        wallet: walletAddress,
      },
    };

    const response = await policyClient.evaluate(policy.id, evalRequest);

    if (log) {
      if (response.decision === "permit") {
        const reasons = permitReasons(policy, amount, response.result ?? {});
        log("Policy passed (remote).");
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

  client.onAfterPaymentCreation(async () => {
    if (log) {
      log("Payment signed; budget updated on server.");
    }
  });

  return wrapFetchWithPayment(baseFetch, client);
}

export class PolicyAwareX402Client {
  private readonly wrappedFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  constructor(config: PolicyAwareX402Config, baseFetch: typeof fetch = fetch) {
    this.wrappedFetch = createPolicyAwareX402Fetch(config, baseFetch);
  }

  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    return this.wrappedFetch(url, init);
  }
}

export { PolicyDeniedError, PolicyEscalationError };
