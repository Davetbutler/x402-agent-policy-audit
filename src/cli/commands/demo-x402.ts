import "dotenv/config";
import { resolve } from "node:path";
import { loadPolicy } from "../../policy/schema.js";
import { BudgetTracker } from "../../policy/budget-tracker.js";
import { AuditLogger } from "../../audit/logger.js";
import { createPolicyAwareX402Fetch } from "../../agentkit/policy-x402-client.js";
import { PolicyDeniedError, PolicyEscalationError } from "../../agentkit/policy-action-provider.js";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import chalk from "chalk";

export async function runX402Demo(options: {
  policyPath: string;
  url: string;
  auditPath: string;
}): Promise<void> {
  const pk = process.env.EVM_PRIVATE_KEY;
  if (!pk?.startsWith("0x")) {
    console.error(
      chalk.red("Set EVM_PRIVATE_KEY in .env (0x-prefixed hex). See .env.example.")
    );
    process.exit(1);
  }

  const doc = loadPolicy(options.policyPath);
  const policy = doc.policy;
  const tracker = new BudgetTracker();
  const audit = new AuditLogger(options.auditPath);

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
    networks: ["eip155:84532", "eip155:8453"],
    log: (msg) => console.log(chalk.gray(msg)),
  });

  console.log(chalk.cyan("Policy:"), policy.name);
  console.log(chalk.cyan("Budget:"), policy.budget.total / 100, policy.budget.currency);
  console.log(chalk.cyan("Fetching"), options.url);
  console.log("");

  try {
    const res = await fetchWithPolicy(options.url);
    console.log("");
    console.log(chalk.green("Status:"), res.status);
    if (res.ok) {
      const text = await res.text();
      let body: { txHash?: string; message?: string } = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      if (body.txHash) {
        console.log(chalk.green("Settlement tx:"), body.txHash);
        audit.emitPaymentSettled(policy, body.txHash);
      }
      console.log("Body:", text || "(empty)");
    } else if (res.status === 402) {
      console.log(
        chalk.gray(
          "(No PAYMENT-SIGNATURE or server did not settle; set MOCK_402_RELAYER_PRIVATE_KEY to enable settlement.)"
        )
      );
    }
  } catch (err) {
    if (err instanceof PolicyDeniedError) {
      console.error(
        chalk.red("Policy denied:"),
        err.response.denial?.code,
        err.response.denial?.message
      );
    } else if (err instanceof PolicyEscalationError) {
      console.error(chalk.yellow("Escalation required:"), err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}
