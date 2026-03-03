import "dotenv/config";
import { AgentKit, walletActionProvider, ViemWalletProvider } from "@coinbase/agentkit";
import { loadPolicy } from "../../policy/schema.js";
import { BudgetTracker } from "../../policy/budget-tracker.js";
import { AuditLogger } from "../../audit/logger.js";
import { PolicyEnforcedActionProvider } from "../../agentkit/policy-action-provider.js";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import chalk from "chalk";

export async function runAgentKitDemo(options: {
  policyPath: string;
  auditPath: string;
}): Promise<void> {
  const evmPk = process.env.EVM_PRIVATE_KEY;
  const evmPublic = process.env.EVM_PUBLIC_KEY;
  const cdpName = process.env.CDP_API_KEY_NAME;
  const cdpPk = process.env.CDP_API_KEY_PRIVATE_KEY;

  const doc = loadPolicy(options.policyPath);
  const policy = doc.policy;
  const tracker = new BudgetTracker();
  const audit = new AuditLogger(options.auditPath);

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

  let agentKit: InstanceType<typeof AgentKit>;

  if (evmPk?.trim()) {
    const pk = evmPk.startsWith("0x") ? evmPk : `0x${evmPk}`;
    const account = privateKeyToAccount(pk as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(),
    });
    const walletProvider = new ViemWalletProvider(walletClient);
    if (evmPublic?.trim()) {
      const expected = evmPublic.startsWith("0x") ? evmPublic : `0x${evmPublic}`;
      if (account.address.toLowerCase() !== expected.toLowerCase()) {
        console.error(
          chalk.red("EVM_PUBLIC_KEY does not match the address derived from EVM_PRIVATE_KEY.")
        );
        process.exit(1);
      }
    }
    console.log(chalk.cyan("Using EVM wallet from .env (no CDP wallet creation)"));
    console.log(chalk.cyan("Address:"), account.address);
    console.log(chalk.cyan("Creating AgentKit with policy-wrapped actions..."));
    agentKit = await AgentKit.from({
      walletProvider,
      actionProviders: [wrappedProvider],
    });
  } else if (cdpName && cdpPk) {
    console.log(chalk.cyan("Creating AgentKit with policy-wrapped actions (CDP wallet)..."));
    agentKit = await AgentKit.from({
      cdpApiKeyName: cdpName,
      cdpApiKeyPrivateKey: cdpPk,
      actionProviders: [wrappedProvider],
    });
  } else {
    console.error(
      chalk.red(
        "Set EVM_PRIVATE_KEY in .env to use your own wallet, or set CDP_API_KEY_NAME and CDP_API_KEY_PRIVATE_KEY. See .env.example."
      )
    );
    process.exit(1);
  }

  const actions = agentKit.getActions();
  console.log(chalk.cyan("Actions:"), actions.map((a) => a.name).join(", "));

  const getDetails = actions.find(
    (a) => a.name === "get_wallet_details" || a.name.endsWith("_get_wallet_details")
  );
  if (!getDetails) {
    console.error(chalk.red("get_wallet_details action not found"));
    process.exit(1);
  }

  console.log(chalk.cyan("\nInvoking get_wallet_details (read-only)..."));
  const result = await getDetails.invoke({});
  console.log(chalk.green("Result:"), result);
  console.log(chalk.dim("\nAudit log:"), options.auditPath);
}
