import { z } from "zod";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// ── Policy Schema ──

export const PermissionSchema = z.object({
  action: z.string(),
  categories: z.array(z.string()),
  providers: z.array(z.string()).optional().default(["*"]),
  max_hold_duration: z.string().optional(),
});

export const BudgetSchema = z.object({
  total: z.number().positive(),
  currency: z.string(),
  per_transaction: z.number().positive(),
  per_period: z
    .object({
      amount: z.number().positive(),
      period: z.enum(["policy_lifetime", "day", "hour"]),
    })
    .optional(),
});

export const EscalationConfigSchema = z.object({
  approval_required_above: z.number().optional(),
  on_category_mismatch: z.enum(["deny", "escalate"]).default("deny"),
  on_budget_exceeded: z.enum(["deny", "escalate"]).default("escalate"),
  escalation_channel: z.string().default("principal"),
  escalation_timeout: z.string().default("1h"),
});

export const DelegationConfigSchema = z.object({
  permitted: z.boolean(),
  max_depth: z.number().int().nonnegative(),
  max_sub_agents: z.number().int().positive(),
  constraints: z.array(z.string()).optional(),
});

export const PolicyObjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  created: z.string().optional(),
  principal: z.object({
    type: z.enum(["human", "agent"]),
    id: z.string(),
    signature: z.string().optional(),
  }),
  agent: z.object({
    id: z.string(),
    wallet: z.string(),
  }),
  validity: z.object({
    not_before: z.string(),
    not_after: z.string(),
  }),
  budget: BudgetSchema,
  permissions: z.array(PermissionSchema),
  escalation: EscalationConfigSchema.optional(),
  delegation: DelegationConfigSchema.optional(),
  on_failure: z
    .object({
      action: z.enum(["suspend_and_notify", "deny_and_continue", "revoke"]),
      notify: z.array(z.string()).optional(),
    })
    .optional(),
  on_expiry: z
    .object({
      action: z.string(),
    })
    .optional(),
  parent: z
    .object({
      policy_id: z.string().nullable(),
      chain: z.array(z.string()),
    })
    .optional(),
});

export const PolicyDocumentSchema = z.object({
  apl_version: z.string(),
  policy: PolicyObjectSchema,
});

// ── Evaluation Request / Response Schemas ──

export const RecipientSchema = z.object({
  id: z.string(),
  category: z.string(),
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
    agent_id: z.string(),
    session_id: z.string().optional(),
    parent_request_id: z.string().nullable().optional(),
    cumulative_spend: z.number().nonnegative().optional(),
    remaining_budget: z.number().nonnegative().optional(),
  }),
});

export const DenialCodes = [
  "BUDGET_TOTAL_EXCEEDED",
  "BUDGET_PER_TX_EXCEEDED",
  "BUDGET_PER_PERIOD_EXCEEDED",
  "CATEGORY_NOT_PERMITTED",
  "PROVIDER_NOT_PERMITTED",
  "ACTION_NOT_PERMITTED",
  "POLICY_EXPIRED",
  "POLICY_NOT_YET_VALID",
  "POLICY_REVOKED",
  "DELEGATION_DEPTH_EXCEEDED",
  "DELEGATION_NOT_PERMITTED",
  "DELEGATION_SUBSET_VIOLATION",
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
  remaining_per_period?: number;
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
export type Policy = z.infer<typeof PolicyObjectSchema>;
export type Permission = z.infer<typeof PermissionSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type EscalationConfig = z.infer<typeof EscalationConfigSchema>;
export type EvaluationRequest = z.infer<typeof EvaluationRequestSchema>;
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

// ── Loader ──

export function loadPolicy(filePath: string): PolicyDocument {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  return PolicyDocumentSchema.parse(parsed);
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
