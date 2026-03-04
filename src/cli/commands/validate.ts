import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import chalk from "chalk";
import { validatePolicy } from "../../policy/schema.js";

export function validatePolicyFile(filePath: string): void {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  const result = validatePolicy(parsed);

  if (result.success) {
    console.log(chalk.green("✓ Policy is valid"));
    console.log(`  id: ${result.data.policy.id ?? "(optional, server assigns UUID on submit)"}`);
    console.log(`  name: ${result.data.policy.name}`);
  } else {
    console.log(chalk.red("✗ Policy validation failed"));
    for (const issue of result.errors.issues) {
      console.log(chalk.red(`  - ${issue.path.join(".")}: ${issue.message}`));
    }
    process.exit(1);
  }
}
