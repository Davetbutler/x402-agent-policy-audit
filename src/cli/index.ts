#!/usr/bin/env node

import { Command } from "commander";
import { showPolicy } from "./commands/show.js";
import { validatePolicyFile } from "./commands/validate.js";
import { evalAction } from "./commands/eval.js";
import { runScenario } from "./commands/run.js";
import { showAudit } from "./commands/audit.js";
import { runDemo } from "./commands/demo.js";

const program = new Command();

program
  .name("apl")
  .description("APL-001 Agent Policy Layer — POC CLI")
  .version("0.1.0");

// ── Policy commands ──

const policyCmd = program.command("policy").description("Policy operations");

policyCmd
  .command("show <file>")
  .description("Display a policy summary")
  .action((file: string) => {
    showPolicy(file);
  });

policyCmd
  .command("validate <file>")
  .description("Validate a policy file")
  .action((file: string) => {
    validatePolicyFile(file);
  });

// ── Eval command ──

program
  .command("eval")
  .description("Evaluate a single action against a policy")
  .requiredOption("--policy <file>", "Path to policy YAML file")
  .requiredOption("--action <json>", "Action JSON (inline or path to .json file)")
  .option("--audit-path <path>", "Audit log path", "audit/events.jsonl")
  .action((opts) => {
    evalAction(opts.policy, opts.action, { auditPath: opts.auditPath });
  });

// ── Run scenario command ──

program
  .command("run")
  .description("Run a canned scenario against a policy")
  .requiredOption("--policy <file>", "Path to policy YAML file")
  .requiredOption("--scenario <name>", "Scenario name (e.g. travel-booking)")
  .option("--audit-path <path>", "Audit log path", "audit/events.jsonl")
  .option(
    "--escalation <mode>",
    "Escalation mode: auto-approve | auto-deny | prompt",
    "auto-approve"
  )
  .action(async (opts) => {
    await runScenario(opts.policy, opts.scenario, {
      auditPath: opts.auditPath,
      escalationMode: opts.escalation,
    });
  });

// ── Demo: interactive agent (policies + x402) ──

program
  .command("demo")
  .description("Run the interactive agent: pick a policy and amount, pay via x402 (policy server + mock 402 server must be running)")
  .action(async () => {
    await runDemo();
  });

// ── Audit command ──

program
  .command("audit")
  .description("Show audit trail")
  .option("--policy <id>", "Filter by policy ID")
  .option("--audit-path <path>", "Audit log path", "audit/events.jsonl")
  .action((opts) => {
    showAudit({ policyId: opts.policy, auditPath: opts.auditPath });
  });

program.parse();
