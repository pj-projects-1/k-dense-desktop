import path from "node:path";
import { spawnSync } from "node:child_process";
import { BACKEND_URL } from "../service-manager.mjs";
const web = path.resolve(import.meta.dirname, "../../web");
const result = spawnSync(process.execPath, [path.join(web, "node_modules/next/dist/bin/next"), "build"], {
  cwd: web,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_ADK_API_URL: BACKEND_URL },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
