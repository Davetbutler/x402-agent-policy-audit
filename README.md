# APL-001: Agent Policy Layer — Proof of Concept

A working implementation of [APL-001: Agent Policy Layer Protocol](./APL-001-agent-policy-protocol.md) — a portable protocol for defining, enforcing, and auditing financial policies for autonomous AI agents.

This POC is **integrated with real Coinbase AgentKit and x402**: policy enforcement runs before AgentKit actions execute and before x402 payments are signed.

## Architecture

```
LLM Agent (LangChain / Vercel AI SDK)
    │
    ▼
AgentKit Framework Extension
    │
    ▼
ActionProviders (transfer, swap, etc.)
    │
    ▼
┌──────────────────────────────┐
│  APL Policy Engine           │  ← This POC
│  - evaluate(request)         │
│  - emit audit events         │
│  - escalation handling       │
└──────────────────────────────┘
    │
    ▼
WalletProvider (CDP Server Wallet)
    │
    ▼
x402 / on-chain settlement
```

**Key components:**

| Component | Path | Purpose |
|-----------|------|---------|
| Policy Schema | `src/policy/schema.ts` | Zod schemas + YAML parser for APL policies |
| Evaluation Engine | `src/policy/engine.ts` | Core `evaluate()` — deny-by-default checks |
| Budget Tracker | `src/policy/budget-tracker.ts` | Per-policy spend accounting |
| Audit Logger | `src/audit/logger.ts` | Append-only JSONL audit events |
| Escalation Handler | `src/agentkit/escalation-handler.ts` | Simulated escalation (auto-approve / prompt) |
| AgentKit Wrapper | `src/agentkit/policy-action-provider.ts` | Wraps ActionProviders with policy enforcement |
| x402 Wrapper | `src/agentkit/policy-x402-client.ts` | Wraps x402 fetch with policy checks |
| CLI | `src/cli/` | `apl` commands for demos and inspection |

## Quick Start

```bash
npm install
```

### Run the demo scenario

```bash
npm run apl -- run --policy policies/travel-booking.yaml --scenario travel-booking
```

This runs the Section 7 example from the spec: Dave's $800 travel budget with a flight purchase (permit), hotel exceeding the approval threshold (escalate), a nightclub payment in a disallowed category (deny), and a second flight over budget (deny).

### Other CLI commands

```bash
# Show policy summary
npm run apl -- policy show policies/travel-booking.yaml

# Validate a policy file
npm run apl -- policy validate policies/travel-booking.yaml

# Evaluate a single action
npm run apl -- eval \
  --policy policies/travel-booking.yaml \
  --action '{"type":"payment","amount":25000,"currency":"USD","recipient":{"id":"merchant:test","category":"flights"}}'

# View the audit trail
npm run apl -- audit

# Run with manual escalation approval (interactive)
npm run apl -- run \
  --policy policies/travel-booking.yaml \
  --scenario travel-booking \
  --escalation prompt
```

### x402 demo (real @x402/fetch + policy hook)

Uses the real x402 client with an `onBeforePaymentCreation` hook so every 402 payment is evaluated against the policy before signing.

1. Copy `.env.example` to `.env` and set `EVM_PRIVATE_KEY` (0x-prefixed hex).
2. Start the mock 402 server (in one terminal):
   ```bash
   npm run demo:mock-402
   ```
3. Run the demo (in another terminal):
   ```bash
   npm run demo:x402
   ```
   Or via CLI: `npm run apl -- demo x402 --url http://localhost:4020/paid`

If the policy permits the mock payment, the client will attempt to sign (the mock server does not settle). If you use a policy or amount that denies, you'll see `PolicyDeniedError`.

### AgentKit demo (real @coinbase/agentkit + policy-wrapped providers)

Runs one AgentKit action (`get_wallet_details`) through a policy-wrapped action provider.

1. Copy `.env.example` to `.env` and set `CDP_API_KEY_NAME` and `CDP_API_KEY_PRIVATE_KEY` (from [CDP](https://portal.cdp.coinbase.com/)).
2. Run:
   ```bash
   npm run demo:agentkit
   ```
   Or: `npm run apl -- demo agentkit`

   **Note:** If you see `ResourceExhaustedError` / `rate limit exceeded for operation: CreateWallet` (HTTP 429), the CDP API has rate-limited wallet creation. Wait a bit and retry, or check your project’s usage in the [Coinbase Developer Platform](https://portal.cdp.coinbase.com/) dashboard.

### Run tests

```bash
npm test
```

## Example Output

```
=== Policy loaded ===
  policy: london-travel-booking (pol_dave_london_001)
  budget: $800.00 total, $400.00 per tx
  categories: flights, hotels, ground_transport, *
  valid: 2026-03-02 → 2026-03-09
  escalation threshold: $350.00

--- Step 1: Flight agent — pay $325 to British Airways (flights) ---
  [EVAL] amount=$325.00, category=flights, per_tx_limit=$400.00, remaining=$800.00
  [PERMIT] within budget and category
  Budget: $800.00 → $475.00 remaining

--- Step 2: Hotel agent — pay $380 to Marriott London (hotels) ---
  [EVAL] amount=$380.00, category=hotels, per_tx_limit=$400.00, remaining=$475.00
  [ESCALATE] Amount 38000 exceeds approval threshold of 35000
  (approved) one-time approval by principal
  Budget: $475.00 → $95.00 remaining

--- Step 3: Payment $200 to nightclub (entertainment — not permitted) ---
  [DENY] CATEGORY_NOT_PERMITTED
  [HINT] Use one of: flights, hotels, ground_transport

--- Step 4: Second flight — pay $500 to Emirates (flights — over budget) ---
  [ESCALATE] Transaction amount exceeds per-transaction limit
  (denied) approved, but total budget would be exceeded — denied

=== Scenario complete ===
  Permits: 2  Denials: 2  Escalations: 2 (2 approved)
  Audit log: audit/events.jsonl
```

## AgentKit Integration

The `PolicyEnforcedActionProvider` wraps any AgentKit `ActionProvider` with policy enforcement:

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { PolicyEnforcedActionProvider } from "@apl/policy-engine-poc";
import { loadPolicy } from "@apl/policy-engine-poc";
import { BudgetTracker } from "@apl/policy-engine-poc";
import { AuditLogger } from "@apl/policy-engine-poc";

const doc = loadPolicy("./policies/travel-booking.yaml");
const tracker = new BudgetTracker();
tracker.init(doc.policy.id, doc.policy.budget.total);
const audit = new AuditLogger("./audit/events.jsonl");

const policyOptions = {
  policy: doc.policy,
  budgetTracker: tracker,
  auditLogger: audit,
};

// Wrap existing providers
const enforcedProviders = rawProviders.map(
  (p) => new PolicyEnforcedActionProvider(p, policyOptions)
);

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: enforcedProviders,
});
```

Every action the agent executes is evaluated against the policy. Denied actions throw `PolicyDeniedError`. Escalated actions throw `PolicyEscalationError` (or are auto-approved/denied depending on config).

## x402 Integration

The POC uses **@x402/fetch** and **@x402/evm**. Policy is enforced via `x402Client.onBeforePaymentCreation`: when a 402 is received, the hook runs APL evaluation and aborts (or throws) if the policy denies.

```typescript
import { createPolicyAwareX402Fetch } from "@apl/policy-engine-poc";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const account = privateKeyToAccount("0x...");
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);

const fetchWithPolicy = createPolicyAwareX402Fetch({
  policy: doc.policy,
  budgetTracker: tracker,
  auditLogger: audit,
  signer,
  networks: ["eip155:84532"],
});

const response = await fetchWithPolicy("https://api.example.com/paid-endpoint");
```

## What This Proves

- Policies are portable and machine-readable (YAML in, typed evaluation out)
- Enforcement sits at the right layer (before wallet/x402, not inside it)
- Audit is a natural byproduct of evaluation (every check = one event)
- Deny-by-default works (unlisted categories, over-limit amounts, expired policies all deny)
- Escalation is part of the model (threshold-based, with simulated approval)
- It fits real stacks (AgentKit ActionProvider wrapping, x402 fetch wrapping)

## What's Deferred (v0.2+)

- Delegation / sub-agent policies and chain verification
- Cryptographic signatures on policies
- Real human-in-the-loop escalation (Slack, email, webhooks)
- Multi-wallet / multi-tenant
- Web UI
- On-chain policy enforcement (ERC-6900/7579 compilation)

## Spec

See [APL-001-agent-policy-protocol.md](./APL-001-agent-policy-protocol.md) for the full protocol specification.
