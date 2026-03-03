import { loadPolicy } from "../../policy/schema.js";
import { formatPolicySummary } from "../formatter.js";

export function showPolicy(filePath: string): void {
  const doc = loadPolicy(filePath);
  console.log(formatPolicySummary(doc.policy));
}
