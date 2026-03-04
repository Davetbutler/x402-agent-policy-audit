import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { PolicyStore } from "./store.js";
import { policiesRouter } from "./routes/policies.js";
import { evaluateRouter } from "./routes/evaluate.js";
import { auditRouter } from "./routes/audit.js";
import { settlementRouter } from "./routes/settlement.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.POLICY_SERVER_PORT ?? 4030);

const store = new PolicyStore("audit/server");

const app = express();
app.use(express.json());
app.use(express.text({ type: ["text/yaml", "application/x-yaml"] }));

const publicDir = path.join(__dirname, "../../public");
app.use(express.static(publicDir));

app.use("/policies", policiesRouter(store));
app.use("/policies", evaluateRouter(store));
app.use("/policies", auditRouter(store));
app.use("/policies", settlementRouter(store));

app.listen(PORT, () => {
  console.log(`APL Policy Server listening on http://localhost:${PORT}`);
  console.log(`Web UI: http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log("  POST   /policies            — Upload policy (JSON or YAML)");
  console.log("  GET    /policies            — List all policies");
  console.log("  GET    /policies/:id        — Get policy by ID");
  console.log("  DELETE /policies/:id        — Remove policy");
  console.log("  POST   /policies/:id/evaluate — Evaluate action against policy");
  console.log("  GET    /policies/:id/audit  — Get audit log for policy");
  console.log("  POST   /policies/:id/settlement — Record payment settlement (tx hash)");
});
