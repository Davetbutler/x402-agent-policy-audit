import type {
  EvaluationRequest,
  EvaluationResponse,
  PolicyDocument,
} from "../policy/schema.js";
import type { AuditEvent } from "../audit/types.js";

export class PolicyClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async uploadPolicy(
    body: PolicyDocument | string
  ): Promise<{ id: string; name: string }> {
    const isString = typeof body === "string";
    const res = await fetch(`${this.baseUrl}/policies`, {
      method: "POST",
      headers: {
        "Content-Type": isString ? "text/yaml" : "application/json",
      },
      body: isString ? body : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload policy failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<{ id: string; name: string }>;
  }

  async evaluate(
    policyId: string,
    request: EvaluationRequest
  ): Promise<EvaluationResponse> {
    const res = await fetch(
      `${this.baseUrl}/policies/${policyId}/evaluate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Evaluate failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<EvaluationResponse>;
  }

  async getPolicy(policyId: string): Promise<PolicyDocument> {
    const res = await fetch(`${this.baseUrl}/policies/${encodeURIComponent(policyId)}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Get policy failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<PolicyDocument>;
  }

  async listPolicies(): Promise<
    Array<{
      id: string;
      name: string;
      description?: string;
      wallets: string[];
      validity: { not_before: string; not_after: string };
      budget: { total: number; currency: string; max_without_approval: number };
    }>
  > {
    const res = await fetch(`${this.baseUrl}/policies`);
    if (!res.ok) {
      throw new Error(`List policies failed (${res.status})`);
    }
    return res.json() as Promise<
      Array<{
        id: string;
        name: string;
        description?: string;
        wallets: string[];
        validity: { not_before: string; not_after: string };
        budget: { total: number; currency: string; max_without_approval: number };
      }>
    >;
  }

  async getAudit(policyId: string): Promise<AuditEvent[]> {
    const res = await fetch(
      `${this.baseUrl}/policies/${policyId}/audit`
    );
    if (!res.ok) {
      throw new Error(`Get audit failed (${res.status})`);
    }
    return res.json() as Promise<AuditEvent[]>;
  }

  /**
   * Records a payment settlement (on-chain transaction hash) in the policy's audit log.
   */
  async recordPaymentSettled(policyId: string, txHash: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/policies/${policyId}/settlement`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Record settlement failed (${res.status}): ${text}`);
    }
  }
}
