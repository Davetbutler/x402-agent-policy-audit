import * as readline from "node:readline";
import type { EvaluationResponse, Policy } from "../policy/schema.js";

export type EscalationMode = "auto-approve" | "auto-deny" | "prompt";

export interface EscalationResult {
  escalation_id: string;
  decision: "approve_once" | "deny";
  approved: boolean;
  principal_id: string;
  timestamp: string;
}

export class EscalationHandler {
  private mode: EscalationMode;

  constructor(mode: EscalationMode = "auto-approve") {
    this.mode = mode;
  }

  async handle(
    policy: Policy,
    response: EvaluationResponse
  ): Promise<EscalationResult> {
    const base = {
      escalation_id: `esc_${response.audit_event_id}`,
      principal_id: policy.principal.id,
      timestamp: new Date().toISOString(),
    };

    switch (this.mode) {
      case "auto-approve":
        return { ...base, decision: "approve_once", approved: true };

      case "auto-deny":
        return { ...base, decision: "deny", approved: false };

      case "prompt":
        return this.promptUser(policy, response, base);
    }
  }

  private async promptUser(
    policy: Policy,
    response: EvaluationResponse,
    base: Omit<EscalationResult, "decision" | "approved">
  ): Promise<EscalationResult> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const denial = response.denial;
    console.error("\n--- ESCALATION REQUEST ---");
    console.error(`Policy: ${policy.name} (${policy.id})`);
    console.error(`Agent: ${policy.agent.id}`);
    if (denial) {
      console.error(`Reason: ${denial.message}`);
      console.error(`Constraint: ${denial.constraint}`);
    }
    console.error("-------------------------");

    const answer = await new Promise<string>((resolve) => {
      rl.question("Approve? (y/n): ", resolve);
    });

    rl.close();

    const approved = answer.trim().toLowerCase() === "y";
    return {
      ...base,
      decision: approved ? "approve_once" : "deny",
      approved,
    };
  }
}
