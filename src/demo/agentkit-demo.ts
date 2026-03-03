/**
 * AgentKit + APL demo: create AgentKit with policy-wrapped action providers,
 * then run one action (get_wallet_details) to show the flow goes through APL.
 *
 * Requires: CDP_API_KEY_NAME and CDP_API_KEY_PRIVATE_KEY in env (or .env).
 * Run: npm run demo:agentkit
 */

import "dotenv/config";
import { resolve } from "node:path";
import { AgentKit, walletActionProvider } from "@coinbase/agentkit";
import { loadPolicy } from "../policy/schema.js";
import { BudgetTracker } from "../policy/budget-tracker.js";
import { AuditLogger } from "../audit/logger.js";
import { PolicyEnforcedActionProvider } from "../agentkit/policy-action-provider.js";

const POLICY_PATH =
  process.env.POLICY_PATH ?? resolve(process.cwd(), "policies/travel-booking.yaml");
const AUDIT_PATH =
  process.env.AUDIT_PATH ?? resolve(process.cwd(), "audit/events.jsonl");

async function main(): Promise<void> {
  const name = process.env.CDP_API_KEY_NAME;
  const pk = process.env.CDP_API_KEY_PRIVATE_KEY;
  if (!name || !pk) {
    console.error(
      "Set CDP_API_KEY_NAME and CDP_API_KEY_PRIVATE_KEY in .env. See .env.example."
    );
    process.exit(1);
  }

  const doc = loadPolicy(POLICY_PATH);
  const policy = doc.policy;
  const tracker = new BudgetTracker();
  const audit = new AuditLogger(AUDIT_PATH);

  tracker.init(policy.id, policy.budget.total);

  const wrappedProvider = new PolicyEnforcedActionProvider(
    walletActionProvider(),
    {
      policy,
      budgetTracker: tracker,
      auditLogger: audit,
      escalationMode: "auto-deny",
    }
  );

  const agentKit = await AgentKit.from({
    cdpApiKeyName: name,
    cdpApiKeyPrivateKey: pk,
    actionProviders: [wrappedProvider],
  });

  const actions = agentKit.getActions();
  console.log("Actions available:", actions.map((a) => a.name).join(", "));

  const getDetails = actions.find((a) => a.name === "get_wallet_details");
  if (!getDetails) {
    console.error("get_wallet_details action not found");
    process.exit(1);
  }

  console.log("\nInvoking get_wallet_details (read-only, policy allows)...");
  const result = await getDetails.invoke({});
  console.log("Result:", result);
  console.log("\nDemo complete. Audit log:", AUDIT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
