# APL-001: Agent Policy Layer Protocol

**Status:** Draft v0.1
**Author:** Dave Butler
**Date:** 2 March 2026
**Category:** Standards Track

---

## Abstract

This document specifies a portable protocol for defining, enforcing, and auditing financial policies for autonomous AI agents. The Agent Policy Layer (APL) sits between agent runtimes and wallet/payment infrastructure, providing a standard way to express what an agent is authorised to do with capital, enforce those constraints at the point of execution, and emit structured audit events for every policy evaluation.

APL is designed to be wallet-agnostic, framework-agnostic, and settlement-agnostic. It does not replace wallet infrastructure (Coinbase AgentKit, Privy, Turnkey, Alchemy) or payment protocols (x402, Stripe). It governs them.

---

## Motivation

AI agents are gaining financial autonomy. Agents can now hold wallets, initiate payments, and delegate to sub-agents. Protocols like x402 solve the "can this agent pay" problem at the HTTP layer. Wallet providers like Privy and Coinbase offer per-wallet spend limits.

What is missing is a portable, auditable governance layer that answers:

- **Should** this agent pay? Under what constraints?
- **Who** authorised this agent, and through what chain of delegation?
- **What happened** — with enough structure that a compliance officer, a CFO, or another agent can reason over it?

Today, every wallet provider implements policy differently. Policies are not portable across providers. There is no standard format that a human can read and sign off on, and no standard audit event that an enterprise compliance tool can consume.

APL closes this gap.

---

## Design Principles

1. **Human-legible, machine-enforceable.** A CFO should be able to read a policy. An engine should be able to evaluate it in <10ms.
2. **Portable.** One policy spec, many enforcement targets. APL compiles to Coinbase, Privy, Turnkey, ERC-6900, ERC-7579, or any future wallet.
3. **Hierarchical.** Delegation is first-class. A child policy must be a provable subset of its parent. Authority flows from human → agent → sub-agent with cryptographic binding at each level.
4. **Audit-native.** Every policy evaluation emits a structured event. Audit is not an add-on — it is a byproduct of enforcement.
5. **Deny-by-default.** If a policy does not explicitly permit an action, it is denied.

---

## 1. Policy Object

A policy is the unit of authorisation. It defines what an agent can do, how much it can spend, where it can spend, when the authority expires, and what it can delegate.

### 1.1 Schema

```yaml
apl_version: "0.1"

policy:
  id: "pol_a1b2c3d4"
  name: "london-travel-booking"
  created: "2026-03-02T09:00:00Z"

  # ── Who authorised this ──
  principal:
    type: "human"                     # human | agent
    id: "did:key:z6Mkf5rG..."        # DID or wallet address of the authoriser
    signature: "0xabc123..."          # principal's signature over this policy object

  # ── Who is authorised to act ──
  agent:
    id: "agent:travel-assistant-v2"
    wallet: "0x742d35Cc..."           # wallet bound to this policy

  # ── Time bounds ──
  validity:
    not_before: "2026-03-02T09:00:00Z"
    not_after: "2026-03-09T23:59:59Z"

  # ── Budget ──
  budget:
    total: 80000              # in smallest unit (cents for USD)
    currency: "USD"
    per_transaction: 40000
    per_period:
      amount: 80000
      period: "policy_lifetime"       # policy_lifetime | day | hour

  # ── Permitted actions ──
  permissions:
    - action: "payment"
      categories: ["flights", "hotels", "ground_transport"]
      providers: ["*"]                # wildcard = any provider
    - action: "search"
      categories: ["*"]
    - action: "hold"                  # pre-authorisation / reservation
      categories: ["hotels"]
      max_hold_duration: "48h"

  # ── Escalation rules ──
  escalation:
    approval_required_above: 35000    # in smallest unit
    on_category_mismatch: "deny"      # deny | escalate
    on_budget_exceeded: "escalate"    # deny | escalate
    escalation_channel: "principal"   # route to principal for approval
    escalation_timeout: "1h"          # auto-deny if no response

  # ── Delegation rules ──
  delegation:
    permitted: true
    max_depth: 2                      # max levels of sub-delegation
    max_sub_agents: 5
    constraints:
      # child policies must satisfy ALL of these
      - "child.budget.total <= parent.budget.remaining"
      - "child.permissions ⊆ parent.permissions"
      - "child.validity.not_after <= parent.validity.not_after"

  # ── Failure behaviour ──
  on_failure:
    action: "suspend_and_notify"      # suspend_and_notify | deny_and_continue | revoke
    notify: ["principal"]

  # ── Termination ──
  on_expiry:
    action: "revoke_and_return"       # revoke all sub-policies, return unspent funds

  # ── Parent policy (if this is a delegated policy) ──
  parent:
    policy_id: null                   # null = root policy (human-issued)
    chain: []                         # ordered list of policy IDs from root to this
```

### 1.2 Policy Rules

1. **Immutability.** A signed policy cannot be modified. To change constraints, the principal revokes the existing policy and issues a new one.
2. **Subset constraint.** A child policy MUST be a strict subset of its parent on every dimension: budget ≤ remaining parent budget, permissions ⊆ parent permissions, validity ≤ parent validity, delegation depth < parent delegation depth.
3. **Signature chain.** Every policy carries the signature of its issuer. The chain of signatures from root (human) to leaf (lowest sub-agent) must be verifiable without trusting any intermediate agent.
4. **Unique binding.** A policy is bound to exactly one wallet address. One wallet, one policy. If an agent needs multiple policies, it uses multiple wallets.

---

## 2. Evaluation Interface

The evaluation interface is the API through which agents (or wallet adapters) ask "is this action permitted?"

### 2.1 Evaluation Request

```json
{
  "apl_version": "0.1",
  "request_id": "req_x7y8z9",
  "policy_id": "pol_a1b2c3d4",
  "timestamp": "2026-03-04T14:32:00Z",

  "action": {
    "type": "payment",
    "amount": 32500,
    "currency": "USD",
    "recipient": {
      "id": "merchant:british-airways",
      "category": "flights",
      "address": "0x1234..."
    },
    "metadata": {
      "description": "LHR-JFK economy return",
      "reference": "BA-2174-2026-03-11"
    }
  },

  "context": {
    "agent_id": "agent:travel-assistant-v2",
    "session_id": "sess_abc123",
    "parent_request_id": null,
    "cumulative_spend": 0,
    "remaining_budget": 80000
  }
}
```

### 2.2 Evaluation Response

```json
{
  "apl_version": "0.1",
  "request_id": "req_x7y8z9",
  "policy_id": "pol_a1b2c3d4",
  "timestamp": "2026-03-04T14:32:01Z",

  "decision": "permit",

  "result": {
    "permitted": true,
    "remaining_budget": 47500,
    "remaining_per_period": 47500,
    "policy_expires_in": "5d 9h 27m"
  },

  "audit_event_id": "evt_m1n2o3"
}
```

### 2.3 Decision Types

| Decision | Meaning | Agent Behaviour |
|----------|---------|-----------------|
| `permit` | Action is within policy. Proceed. | Execute the action. |
| `deny` | Action violates policy. Do not proceed. | Stop. Log the reason. Do not retry without modification. |
| `escalate` | Action requires human approval. | Pause. Present structured approval request to principal. Wait for response or timeout. |
| `deny_with_reason` | Action denied with a specific, actionable reason the agent can use. | Agent may modify the action and retry (e.g., reduce amount, change category). |

### 2.4 Denial Reasons (Typed)

When the decision is `deny` or `deny_with_reason`, the response includes a typed reason:

```json
{
  "decision": "deny_with_reason",
  "denial": {
    "code": "BUDGET_PER_TX_EXCEEDED",
    "message": "Transaction amount 42000 exceeds per-transaction limit of 40000",
    "constraint": "budget.per_transaction",
    "limit": 40000,
    "requested": 42000,
    "suggestion": "Reduce amount to 40000 or request escalation"
  }
}
```

**Denial codes:**

| Code | Meaning |
|------|---------|
| `BUDGET_TOTAL_EXCEEDED` | Cumulative spend would exceed total budget |
| `BUDGET_PER_TX_EXCEEDED` | Single transaction exceeds per-transaction limit |
| `BUDGET_PER_PERIOD_EXCEEDED` | Spend in current period exceeds period limit |
| `CATEGORY_NOT_PERMITTED` | Merchant/service category not in permissions |
| `PROVIDER_NOT_PERMITTED` | Specific provider not in permissions |
| `ACTION_NOT_PERMITTED` | Action type not in permissions |
| `POLICY_EXPIRED` | Policy validity period has ended |
| `POLICY_NOT_YET_VALID` | Policy validity period has not started |
| `POLICY_REVOKED` | Policy has been revoked by principal or parent |
| `DELEGATION_DEPTH_EXCEEDED` | Sub-agent delegation would exceed max depth |
| `DELEGATION_NOT_PERMITTED` | Policy does not allow delegation |
| `DELEGATION_SUBSET_VIOLATION` | Child policy is not a strict subset of parent |

---

## 3. Audit Event Format

Every policy evaluation — permit, deny, or escalate — emits a structured audit event. Audit is not optional. It is a mandatory byproduct of enforcement.

### 3.1 Audit Event Schema

```json
{
  "apl_version": "0.1",
  "event_id": "evt_m1n2o3",
  "event_type": "policy_evaluation",
  "timestamp": "2026-03-04T14:32:01Z",

  "policy": {
    "id": "pol_a1b2c3d4",
    "name": "london-travel-booking",
    "principal_id": "did:key:z6Mkf5rG...",
    "agent_id": "agent:travel-assistant-v2",
    "chain": []
  },

  "request": {
    "request_id": "req_x7y8z9",
    "action_type": "payment",
    "amount": 32500,
    "currency": "USD",
    "recipient_id": "merchant:british-airways",
    "recipient_category": "flights"
  },

  "decision": {
    "outcome": "permit",
    "denial_code": null,
    "escalated_to": null,
    "evaluation_duration_ms": 3
  },

  "budget_state": {
    "total_budget": 80000,
    "spent_before": 0,
    "spent_after": 32500,
    "remaining": 47500
  },

  "delegation_context": {
    "depth": 0,
    "parent_policy_id": null,
    "root_principal_id": "did:key:z6Mkf5rG..."
  }
}
```

### 3.2 Additional Event Types

Beyond `policy_evaluation`, the audit stream includes:

| Event Type | Trigger |
|------------|---------|
| `policy_created` | New policy signed and bound to wallet |
| `policy_revoked` | Policy revoked by principal or parent agent |
| `policy_expired` | Policy reached its not_after timestamp |
| `policy_delegated` | Parent policy created a child policy for a sub-agent |
| `escalation_requested` | Action paused pending human approval |
| `escalation_resolved` | Human approved or denied an escalation |
| `escalation_timeout` | Escalation auto-denied after timeout |
| `budget_warning` | Spend reached 80% of total budget (configurable) |
| `funds_returned` | Unspent funds returned to principal on policy expiry/revocation |

### 3.3 Audit Guarantees

1. **Completeness.** Every policy evaluation produces exactly one audit event. No silent failures.
2. **Ordering.** Events for a single policy are strictly ordered by timestamp.
3. **Immutability.** Audit events, once emitted, cannot be modified or deleted.
4. **Traceability.** Every event references the full policy chain from root principal to acting agent.

---

## 4. Delegation Model

Delegation is the mechanism by which an agent spawns a sub-agent and grants it a constrained subset of its own authority.

### 4.1 Delegation Flow

```
Human (principal)
  │
  ├── signs Policy A (total: $800, categories: [flights, hotels, transport])
  │       │
  │       └── Agent 1 (travel-assistant)
  │             │
  │             ├── delegates Policy A.1 (total: $400, categories: [flights])
  │             │       │
  │             │       └── Agent 1.1 (flight-searcher)
  │             │
  │             └── delegates Policy A.2 (total: $350, categories: [hotels])
  │                     │
  │                     └── Agent 1.2 (hotel-booker)
  │
  └── Remaining $50 held by Agent 1 for transport
```

### 4.2 Delegation Rules

1. **Budget conservation.** The sum of all child budgets must not exceed the parent's remaining budget. `Σ(child.budget.total) ≤ parent.budget.remaining`
2. **Permission narrowing.** A child's permissions must be a subset of the parent's. A child cannot grant itself categories, actions, or providers the parent does not have.
3. **Temporal narrowing.** A child's validity window must be within the parent's. A child cannot outlive its parent.
4. **Depth limit.** Delegation depth is bounded by the root policy. If `max_depth = 2`, Agent 1 can delegate to Agent 1.1, but Agent 1.1 cannot delegate further.
5. **Revocation cascades.** Revoking a parent policy immediately revokes all children. Revoking a child does not affect the parent or siblings.

### 4.3 Chain Verification

Every child policy carries a `chain` field — an ordered list of policy IDs from root to itself. Any party can verify the chain by checking that each policy in the chain is signed by the agent that holds the parent policy, and that each child satisfies the subset constraint.

```yaml
# Policy A.1 (flight-searcher)
parent:
  policy_id: "pol_a1b2c3d4"
  chain: ["pol_a1b2c3d4", "pol_e5f6g7h8"]
  parent_signature: "0xdef456..."
```

---

## 5. Wallet Adapter Interface

APL does not implement wallets. It defines a standard interface that wallet providers implement.

### 5.1 Adapter Contract

Any wallet provider that implements the APL adapter must support:

```
apl.bind(policy, wallet_address) → binding_receipt
  # Binds a policy to a wallet. The wallet will only execute
  # transactions that pass APL evaluation.

apl.evaluate(request) → response
  # Evaluates an action against the bound policy.
  # Returns permit / deny / escalate.

apl.revoke(policy_id) → revocation_receipt
  # Revokes a policy and all its children.
  # Freezes the wallet. Returns unspent funds.

apl.state(policy_id) → policy_state
  # Returns current budget state, active sub-policies,
  # and recent audit events.
```

### 5.2 Reference Adapters (Planned)

| Wallet Provider | Adapter Status | Notes |
|----------------|----------------|-------|
| Coinbase AgentKit | Planned (v0.2) | First target. x402 integration natural. |
| Privy | Planned (v0.3) | Map APL policies to Privy policy engine. |
| Turnkey | Planned (v0.3) | Map APL policies to Turnkey signing policies. |
| Alchemy (ERC-6900) | Planned (v0.4) | Compile APL policies to ERC-6900 plugins. |
| thirdweb (ERC-7579) | Planned (v0.4) | Compile APL policies to ERC-7579 modules. |

---

## 6. Escalation Protocol

When an action triggers an escalation, the agent pauses and the protocol surfaces a structured approval request to the human principal.

### 6.1 Escalation Request

```json
{
  "escalation_id": "esc_p1q2r3",
  "policy_id": "pol_a1b2c3d4",
  "agent_id": "agent:travel-assistant-v2",
  "timestamp": "2026-03-04T15:10:00Z",

  "action": {
    "type": "payment",
    "amount": 42000,
    "currency": "USD",
    "recipient": "merchant:british-airways",
    "description": "LHR-JFK business class return"
  },

  "reason": "BUDGET_PER_TX_EXCEEDED",
  "constraint": "Per-transaction limit is $400. This transaction is $420.",

  "options": [
    { "id": "approve_once", "label": "Approve this transaction only" },
    { "id": "raise_limit", "label": "Raise per-transaction limit to $500" },
    { "id": "deny", "label": "Deny" }
  ],

  "timeout": "2026-03-04T16:10:00Z",
  "timeout_action": "deny"
}
```

### 6.2 Escalation Response

```json
{
  "escalation_id": "esc_p1q2r3",
  "decision": "approve_once",
  "principal_id": "did:key:z6Mkf5rG...",
  "signature": "0x789abc...",
  "timestamp": "2026-03-04T15:15:00Z"
}
```

An `approve_once` does not modify the policy. It creates a one-time exception recorded in the audit trail. A `raise_limit` creates a new policy version (the old one is revoked, the new one is signed).

---

## 7. Example: End-to-End Flow

### Scenario: Dave asks an agent to book travel to London

**Step 1: Policy creation**

Dave expresses intent: "Book me travel to London next Tuesday, keep it under $800."

The system proposes a policy. Dave reviews and signs it.

```yaml
policy:
  id: "pol_dave_london_001"
  name: "london-trip-march"
  principal:
    type: "human"
    id: "did:key:z6Mkf5rGdave..."
  agent:
    id: "agent:travel-assistant"
    wallet: "0xAAA..."
  validity:
    not_before: "2026-03-02T09:00:00Z"
    not_after: "2026-03-09T23:59:59Z"
  budget:
    total: 80000
    currency: "USD"
    per_transaction: 40000
  permissions:
    - action: "payment"
      categories: ["flights", "hotels", "ground_transport"]
  escalation:
    approval_required_above: 35000
  delegation:
    permitted: true
    max_depth: 1
    max_sub_agents: 3
```

**Step 2: Agent delegates to sub-agents**

The travel assistant spawns two sub-agents:

- Flight agent: budget $450, category [flights] only
- Hotel agent: budget $300, category [hotels] only
- Remaining $50 retained by parent for ground transport

Each gets a child policy, a child wallet, and a chain reference back to Dave.

**Step 3: Flight agent finds a fare**

Flight agent requests evaluation:

```
Action: payment, $325, british-airways, category: flights
→ Policy engine evaluates
→ Decision: PERMIT (within budget, within category, below approval threshold)
→ Audit event emitted
→ x402 payment executes
```

**Step 4: Hotel agent finds a rate that exceeds approval threshold**

Hotel agent requests evaluation:

```
Action: payment, $380, marriott-london, category: hotels
→ Policy engine evaluates
→ Decision: ESCALATE (amount $380 > approval threshold $350)
→ Escalation request sent to Dave
→ Dave approves (one-time exception)
→ Audit event records the exception + Dave's approval signature
→ Payment executes
```

**Step 5: Completion**

All sub-agent policies are revoked. Unspent budget ($95) is returned to Dave's wallet. The audit trail is sealed: 2 payments, 1 escalation, 1 approval, 2 sub-policy delegations, 2 sub-policy revocations. Dave receives a summary.

---

## 8. Open Questions (v0.2)

These are intentionally unresolved in v0.1 and marked for future work:

1. **Category taxonomy.** Who defines the canonical list of merchant/service categories? Is it a registry, an open taxonomy, or provider-specific? This affects interoperability.

2. **Offline evaluation.** Can the policy engine evaluate without network access (e.g., fully on-device or on-chain)? What are the latency and state sync implications?

3. **Multi-currency budgets.** How does a policy handle budgets across currencies? Is FX conversion part of the policy engine or delegated to the settlement layer?

4. **Dispute resolution.** If an agent pays for something that is not delivered, what recourse exists? Is this in-scope for APL or delegated to a separate protocol?

5. **Agent reputation.** How does successful policy compliance build agent reputation over time? Could reputation unlock higher budget limits or reduced escalation requirements?

6. **Privacy.** Audit events contain financial data. What is the access control model for the audit stream? Who can read it?

7. **Gas/fees.** On-chain policy evaluation has gas costs. How are these accounted for within the budget? Does the policy engine deduct fees from the budget automatically?

---

## 9. Relationship to Existing Standards

| Standard | Relationship to APL |
|----------|-------------------|
| x402 | APL governs **when** x402 payments execute. x402 is the payment primitive; APL is the policy primitive. |
| ERC-4337 (Account Abstraction) | APL policies can be enforced via AA UserOp validation. APL is a higher-level abstraction. |
| ERC-6900 (Modular Accounts) | APL policies compile to ERC-6900 plugins as one enforcement target. |
| ERC-7579 (Minimal Modular Accounts) | APL policies compile to ERC-7579 modules as one enforcement target. |
| ERC-7715 (Permission Requests) | Complementary. ERC-7715 handles permission request flow; APL handles the policy content and audit. |
| OPA (Open Policy Agent) | Architectural inspiration. APL is "OPA for agent finance." |
| UCAN / ZCAP-LD | Capability-based auth models. APL's delegation chain draws from the same conceptual lineage. |

---

## Appendix A: Terminology

| Term | Definition |
|------|-----------|
| **Principal** | The human (or parent agent) that issues a policy and bears ultimate responsibility. |
| **Agent** | An autonomous system that acts within a policy's constraints. |
| **Policy** | A signed, immutable object defining an agent's financial authority. |
| **Evaluation** | A single check of an action against a policy, producing a decision and an audit event. |
| **Escalation** | A pause in execution where the agent requests human approval for an action that exceeds policy limits. |
| **Delegation** | The act of an agent creating a child policy for a sub-agent, constrained to a subset of its own authority. |
| **Adapter** | A wallet-provider-specific implementation of the APL interface. |
| **Chain** | The ordered list of policy IDs from root principal to the current agent, enabling full traceability. |

---

*APL-001 is a living document. Feedback and contributions are welcome.*
