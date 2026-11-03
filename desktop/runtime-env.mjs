import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Finder does not inherit interactive shell startup files. Add conventional
// tool locations without executing user shell configuration at app startup.
export function runtimeEnvironment({ externalsDir, env = process.env, platform = process.platform } = {}) {
  if (platform !== "darwin") return { ...env };
  const home = env.HOME || os.homedir();
  const systemDirs = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const dirs = [
    ...(externalsDir ? [path.join(externalsDir, "bin"), path.join(externalsDir, "uv")] : []),
    ...(env.PATH || "").split(":").filter(dir => !systemDirs.includes(dir)),
    "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"),
    ...systemDirs,
  ].filter(Boolean);
  return { ...env, PATH: [...new Set(dirs)].join(":"), SHELL: "/bin/bash" };
}

export function runnable(command, env) {
  return spawnSync(command, ["--version"], { env, stdio: "ignore", timeout: 5000 }).status === 0;
}

export function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

export function portHelp(ports, platform = process.platform) {
  if (platform === "win32") {
    return "Open Command Prompt and run\n" + ports.map(p => `    netstat -ano | findstr :${p}`).join("\n") +
      "\nMatch the process ID in Task Manager's Details tab.";
  }
  return "Open Terminal and run\n" + ports.map(p => `    lsof -nP -iTCP:${p} -sTCP:LISTEN`).join("\n") +
    "\nQuit the application that owns the port, then try again.";
}
