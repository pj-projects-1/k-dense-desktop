// Exercise shipped dependencies with temporary Kady projects and Pi auth.
// No prompt is sent. Ambient user skills may still be discovered by the SDK.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtime = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../build/runtime"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-session-smoke-"));
const inherited = new Set([
  "HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "ELECTRON_RUN_AS_NODE",
]);
for (const name of Object.keys(process.env)) {
  if (!inherited.has(name)) delete process.env[name];
}
Object.assign(process.env, {
  KADY_DATA_ROOT: root,
  KADY_PI_AGENT_DIR: path.join(root, "pi-agent"),
  PI_CODING_AGENT_DIR: path.join(root, "pi-agent"),
  KADY_SKILLS_CACHE_DIR: path.join(root, "skills-cache"),
  KADY_SKILLS_AUTO_SYNC: "0",
  PI_OFFLINE: "1",
  AWS_EC2_METADATA_DISABLED: "true",
  LOG_LEVEL: "silent",
});
let app;
let registry;
try {
  const { buildApp } = await import(pathToFileURL(path.join(runtime, "server/src/index.mjs")));
  registry = await import(pathToFileURL(path.join(runtime, "server/src/agent/session-registry.mjs")));
  app = await buildApp();
  const response = await app.inject({ method: "POST", url: "/sessions", headers: { "x-project-id": "default" }, payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.json().id, "Session ID missing");
  const prompts = fs.readdirSync(path.join(runtime, "server/node_modules/pi-subagents/prompts"));
  assert.ok(prompts.includes("parallel-research.md"), "Built-in prompt missing");
  console.log("PASS: packaged backend creates a chat session with temporary Kady projects and Pi auth; no LLM request sent.");
} finally {
  await registry?.shutdownLiveSessions();
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
