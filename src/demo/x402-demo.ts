/**
 * x402 + APL demo: policy-aware fetch against a 402 endpoint.
 * Loads a policy, builds createPolicyAwareX402Fetch with an EVM signer,
 * and calls the wrapped fetch. On permit the payment is sent; on deny
 * PolicyDeniedError is thrown.
 *
 * Requires: EVM_PRIVATE_KEY in env (or .env). Optional: POLICY_PATH, AUDIT_PATH.
 * Run the mock server first: npm run demo:mock-402
 * Then: npm run demo:x402
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadPolicy } from "../policy/schema.js";
import { BudgetTracker } from "../policy/budget-tracker.js";
import { AuditLogger } from "../audit/logger.js";
import { createPolicyAwareX402Fetch } from "../agentkit/policy-x402-client.js";
import { PolicyDeniedError, PolicyEscalationError } from "../agentkit/policy-action-provider.js";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const POLICY_PATH = process.env.POLICY_PATH ?? resolve(process.cwd(), "policies/travel-booking.yaml");
const AUDIT_PATH = process.env.AUDIT_PATH ?? resolve(process.cwd(), "audit/events.jsonl");
const DEMO_URL = process.env.DEMO_402_URL ?? "http://localhost:4020/paid";

function main(): void {
  const pk = process.env.EVM_PRIVATE_KEY;
  if (!pk?.startsWith("0x")) {
    console.error("Set EVM_PRIVATE_KEY in .env (0x-prefixed hex). See .env.example.");
    process.exit(1);
  }

  const doc = loadPolicy(POLICY_PATH);
  const policy = doc.policy;
  const tracker = new BudgetTracker();
  const audit = new AuditLogger(AUDIT_PATH);

  const account = privateKeyToAccount(pk as `0x${string}`);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });
  const signer = toClientEvmSigner(account, publicClient);

  const fetchWithPolicy = createPolicyAwareX402Fetch({
    policy,
    budgetTracker: tracker,
    auditLogger: audit,
    signer,
    networks: ["eip155:84532"],
  });

  console.log("Policy:", policy.name);
  console.log("Budget:", policy.budget.total / 100, policy.budget.currency);
  console.log("Fetching", DEMO_URL, "...\n");

  fetchWithPolicy(DEMO_URL)
    .then(async (res) => {
      console.log("Status:", res.status);
      if (res.ok) {
        const text = await res.text();
        console.log("Body:", text || "(empty)");
      }
    })
    .catch((err) => {
      if (err instanceof PolicyDeniedError) {
        console.error("Policy denied:", err.response.denial?.code, err.response.denial?.message);
      } else if (err instanceof PolicyEscalationError) {
        console.error("Escalation required:", err.message);
      } else {
        console.error(err);
      }
      process.exit(1);
    });
}

main();
