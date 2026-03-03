import chalk from "chalk";
import { AuditLogger } from "../../audit/logger.js";
import { formatAuditEvent } from "../formatter.js";

export function showAudit(options: {
  auditPath?: string;
  policyId?: string;
}): void {
  const auditPath = options.auditPath ?? "audit/events.jsonl";
  const logger = new AuditLogger(auditPath);
  let events = logger.getEventsFromFile();

  if (events.length === 0) {
    console.log(chalk.dim("No audit events found."));
    return;
  }

  if (options.policyId) {
    events = events.filter((e) => e.policy.id === options.policyId);
  }

  console.log(chalk.bold.cyan(`=== Audit Trail (${events.length} events) ===\n`));
  for (const event of events) {
    console.log(formatAuditEvent(event));
    console.log();
  }
}
