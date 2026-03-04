import { z } from "zod";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// ── Policy Schema (reduced scope) ──

/** Allowed action types for this policy (e.g. ["payment", "search"]). */
export const PermissionsSchema = z.array(z.string()).min(1);

export const BudgetSchema = z.object({
  total: z.number().positive(),
  currency: z.string(),
});

export const PolicyObjectSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  /** Human-readable description of what this policy is for. */
  description: z.string().optional(),
  created: z.string().optional(),
  /** Public wallet addresses allowed to act under this policy. Only these wallets can submit requests. */
  wallets: z.array(z.string()).min(1),
  validity: z.object({
    not_before: z.string(),
    not_after: z.string(),
  }),
  budget: BudgetSchema,
  /** Max amount (same units as budget) allowed without approval; above this requires escalation. */
  max_without_approval: z.number().nonnegative(),
  permissions: PermissionsSchema,
});

export const PolicyDocumentSchema = z.object({
  apl_version: z.string(),
  policy: PolicyObjectSchema,
});

// ── Evaluation Request / Response Schemas ──

export const RecipientSchema = z.object({
  id: z.string(),
  address: z.string().optional(),
});

export const ActionRequestSchema = z.object({
  type: z.string(),
  amount: z.number().nonnegative(),
  currency: z.string(),
  recipient: RecipientSchema,
  metadata: z.record(z.string(), z.string()).optional(),
});

export const EvaluationRequestSchema = z.object({
  apl_version: z.string().default("0.1"),
  request_id: z.string(),
  policy_id: z.string(),
  timestamp: z.string(),
  action: ActionRequestSchema,
  context: z.object({
    /** Wallet address of the agent making the request; must be in policy.wallets. */
    wallet: z.string(),
    agent_id: z.string().optional(),
    session_id: z.string().optional(),
    parent_request_id: z.string().nullable().optional(),
    cumulative_spend: z.number().nonnegative().optional(),
    remaining_budget: z.number().nonnegative().optional(),
  }),
});

export const DenialCodes = [
  "BUDGET_TOTAL_EXCEEDED",
  "BUDGET_PER_TX_EXCEEDED",
  "AMOUNT_ABOVE_APPROVAL_THRESHOLD",
  "ACTION_NOT_PERMITTED",
  "POLICY_EXPIRED",
  "POLICY_NOT_YET_VALID",
  "POLICY_REVOKED",
  "WALLET_NOT_ALLOWED",
] as const;

export type DenialCode = (typeof DenialCodes)[number];

export const DecisionTypes = [
  "permit",
  "deny",
  "escalate",
  "deny_with_reason",
] as const;

export type Decision = (typeof DecisionTypes)[number];

export interface DenialInfo {
  code: DenialCode;
  message: string;
  constraint: string;
  limit?: number;
  requested?: number;
  suggestion?: string;
}

export interface EvaluationResult {
  permitted: boolean;
  remaining_budget: number;
  policy_expires_in?: string;
}

export interface EvaluationResponse {
  apl_version: string;
  request_id: string;
  policy_id: string;
  timestamp: string;
  decision: Decision;
  result?: EvaluationResult;
  denial?: DenialInfo;
  audit_event_id: string;
}

// ── Inferred Types ──

export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;
export type Policy = z.infer<typeof PolicyObjectSchema> & { id: string };
export type Permissions = z.infer<typeof PermissionsSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type EvaluationRequest = z.infer<typeof EvaluationRequestSchema>;
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

// ── Loader ──

export function loadPolicy(filePath: string): PolicyDocument {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  const doc = PolicyDocumentSchema.parse(parsed);
  if (!doc.policy.id) {
    throw new Error("Policy file must include policy.id");
  }
  return doc as PolicyDocument & { policy: Policy };
}

export function validatePolicy(
  data: unknown
): { success: true; data: PolicyDocument } | { success: false; errors: z.ZodError } {
  const result = PolicyDocumentSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error };
}
