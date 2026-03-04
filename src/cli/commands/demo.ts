/**
 * Interactive agent demo: CLI agent tied to the wallet in .env.
 * Fetches policies from the policy server (filtered by this wallet), lets the user
 * pick a policy and amount, then runs the x402 flow. Results show in the audit log.
 *
 * Prerequisites:
 * - POLICY_SERVER_URL (default http://localhost:4030) — policy server running
 * - MOCK_402_URL (default http://localhost:4020) — mock x402 server running (npm run demo:mock-402)
 * - EVM_PRIVATE_KEY — agent wallet
 */

import "dotenv/config";
import * as readline from "node:readline";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { toClientEvmSigner } from "@x402/evm";
import chalk from "chalk";
import { PolicyClient } from "../../client/policy-client.js";
import { createPolicyAwareX402Fetch } from "../../agentkit/policy-x402-client.js";
import { PolicyDeniedError, PolicyEscalationError } from "../../agentkit/policy-action-provider.js";
import type { PolicyDocument } from "../../policy/schema.js";

const POLICY_SERVER_URL = process.env.POLICY_SERVER_URL ?? "http://localhost:4030";
const MOCK_402_URL = (process.env.MOCK_402_URL ?? "http://localhost:4020").replace(/\/$/, "");
const EVM_PK = process.env.EVM_PRIVATE_KEY;

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve((answer ?? "").trim()));
  });
}

export async function runDemo(): Promise<void> {
  if (!EVM_PK?.trim()) {
    console.error(chalk.red("Set EVM_PRIVATE_KEY in .env to run the agent demo."));
    process.exit(1);
  }

  const pk = EVM_PK.startsWith("0x") ? EVM_PK : `0x${EVM_PK}`;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const walletAddress = account.address;

  const policyClient = new PolicyClient(POLICY_SERVER_URL);

  console.log(chalk.cyan("Agent wallet:"), walletAddress);
  console.log(chalk.cyan("Policy server:"), POLICY_SERVER_URL);
  console.log(chalk.cyan("Fetching policies for this wallet...\n"));

  let policies: Array<{ id: string; name: string; description?: string; wallets: string[] }>;
  try {
    const all = await policyClient.listPolicies();
    const allowed = all.filter((p) =>
      p.wallets.some((w) => w.trim().toLowerCase() === walletAddress.toLowerCase())
    );
    if (allowed.length === 0) {
      console.error(chalk.yellow("No policies found for your wallet. Upload policies that include this wallet address."));
      process.exit(1);
    }
    policies = allowed;
  } catch (err) {
    console.error(chalk.red("Failed to list policies:"), err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });
  const signer = toClientEvmSigner(account, publicClient);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (;;) {
    console.log(chalk.bold("What would you like me to do? I can:\n"));
    policies.forEach((p, i) => {
      const label = p.description || p.name;
      console.log(`  ${chalk.cyan(String(i + 1) + ".")} ${label}`);
    });
    console.log(`  ${chalk.dim("0.")} Exit\n`);

    const choice = await ask(rl, "Your choice (number): ");
    if (choice === "0") {
      console.log(chalk.dim("Bye."));
      rl.close();
      process.exit(0);
    }

    const idx = parseInt(choice, 10);
    if (Number.isNaN(idx) || idx < 1 || idx > policies.length) {
      console.log(chalk.yellow("Invalid choice. Try again.\n"));
      continue;
    }

    const selected = policies[idx - 1];
    let doc: PolicyDocument;
    try {
      doc = await policyClient.getPolicy(selected.id);
    } catch (err) {
      console.error(chalk.red("Failed to load policy:"), err instanceof Error ? err.message : err);
      continue;
    }

    const amountStr = await ask(rl, "How much would you like to spend (USD)? ");
    const amountUsd = parseFloat(amountStr);
    if (Number.isNaN(amountUsd) || amountUsd <= 0) {
      console.log(chalk.yellow("Enter a positive number (e.g. 15.50).\n"));
      continue;
    }
    const amountCents = Math.round(amountUsd * 100);

    const url = `${MOCK_402_URL}/paid?amount=${amountCents}`;
    const fetchWithPolicy = createPolicyAwareX402Fetch({
      policy: doc.policy,
      policyClient,
      signer,
      walletAddress,
      networks: ["eip155:84532", "eip155:8453"],
      log: (msg) => console.log(chalk.gray("  " + msg)),
    });

    console.log(chalk.dim(`  Requesting ${amountUsd} USD (${amountCents} cents) via x402...`));

    try {
      const res = await fetchWithPolicy(url);
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.txHash) {
        await policyClient.recordPaymentSettled(doc.policy.id, body.txHash);
        console.log(chalk.green("  Payment completed. Tx:"), body.txHash);
        console.log(chalk.dim("  See the policy audit log for details.\n"));
      } else if (res.ok) {
        console.log(chalk.green("  Request completed.\n"));
      } else {
        console.log(chalk.yellow("  Response:"), res.status, body?.error ?? "");
      }
    } catch (err) {
      if (err instanceof PolicyDeniedError) {
        console.log(chalk.red("  Denied:"), err.response.denial?.message ?? err.message);
        console.log(chalk.dim("  (Amount may be over budget or not allowed for this policy.)\n"));
      } else if (err instanceof PolicyEscalationError) {
        console.log(chalk.yellow("  This amount requires approval (above max without approval).\n"));
      } else {
        console.error(chalk.red("  Error:"), err instanceof Error ? err.message : err);
      }
    }
  }
}
