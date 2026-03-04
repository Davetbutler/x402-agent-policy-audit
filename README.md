# APL-001: Agent Policy Layer — Proof of Concept

A working implementation of [APL-001: Agent Policy Layer Protocol](./APL-001-agent-policy-protocol.md) — defining, enforcing, and auditing financial policies for autonomous agents. This POC integrates with **x402**: policy is enforced on a remote server before payments are signed.

---

## Setup

### 1. Install and configure

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- **Policy server & webapp** — no extra keys required; they run as-is.
- **x402 demo** — set `EVM_PRIVATE_KEY` (agent wallet, 0x-prefixed). For real on-chain settlement on Base Sepolia, also set `MOCK_402_RELAYER_PRIVATE_KEY` (relayer wallet; pays gas). You can get testnet USDC from [Circle’s Base Sepolia faucet](https://faucet.circle.com/) if you want real payments.

### 2. Policy server (and webapp)

Start the policy server; it serves both the REST API and the web UI:

```bash
npm run server
```

- **API:** http://localhost:4030  
- **Web UI:** http://localhost:4030  

In the webapp you can create policies (name, wallets, budget, validity), delete them, and view the **audit log** per policy (with live polling). Policy IDs are assigned by the server on submit.

### 3. x402 server (for the agent demo)

In a **separate terminal**, start the mock x402 server:

```bash
npm run demo:mock-402
```

- Listens on http://localhost:4020  
- Responds to `/paid?amount=<cents>` with `402 Payment Required` and, when `MOCK_402_RELAYER_PRIVATE_KEY` is set, settles EIP-3009 USDC payments on Base Sepolia and returns the transaction hash.

---

## What’s going on / Flow

1. **Policy server** holds policies and audit state. You define policies (e.g. total budget, max per payment, allowed wallets, validity window) and the server assigns an ID. All evaluations and payment settlements are recorded in that policy’s audit log.

2. **Webapp** talks to the policy server: submit or delete policies, pick a policy, and see its audit log. The audit log is loaded and polled automatically so new events (e.g. after a payment) show up. Transaction hashes in the log link to [Base Sepolia BaseScan](https://sepolia.basescan.org/).

3. **Agent demo** (`npm run apl -- demo`) runs a CLI “agent” tied to the wallet in `EVM_PRIVATE_KEY`. On start it fetches from the policy server the list of policies that include that wallet. You choose a policy (by description) and an amount in USD - this mimics you telling the agent "please go and take action X, you have $Y to do it with" (e.g. book my travel). The agent then:
   - Calls the **policy server** to evaluate the payment (budget, limits, validity).
   - If permitted, signs the payment (EIP-3009) and sends it to the **x402 server**.
   - The x402 server settles on-chain (when relayer key is set) and returns the tx hash.
   - The agent notifies the **policy server** of the settlement; the server appends one combined audit entry (evaluation + tx hash).

In the real world, the "x402 server" would be the payment mechanism for the product the agent is consuming or paying for.

4. **x402 server** is a minimal mock: it returns 402 with a payment requirement and, when configured, submits the signed authorization to the USDC contract on Base Sepolia and responds with the transaction hash. In production this would be a real payment-accepting service.

End-to-end: **policy server** (policies + audit) → **agent** (evaluate → sign → pay) → **x402 server** (settle). The webapp is the place to manage policies and watch the audit log.

---

## Quick reference

| Command | Purpose |
|--------|--------|
| `npm run server` | Policy server + webapp (port 4030) |
| `npm run demo:mock-402` | Mock x402 server (port 4020) |
| `npm run apl -- demo` | Interactive agent (policy server + x402 server must be running) |
| `npm run apl -- run --policy <file> --scenario travel-booking` | Run scenario from a local policy file (no server) |
| `npm test` | Run tests |

Spec: [APL-001-agent-policy-protocol.md](./APL-001-agent-policy-protocol.md).
