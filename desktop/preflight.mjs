/**
 * Startup readiness checks.
 *
 * The agent's failure mode without a shell is opaque: every tool call returns
 * an error the user cannot act on. Check the things we know it needs up front
 * and report them in one place, before the window opens.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { runtimeEnvironment, runnable, executable } from "./runtime-env.mjs";

/**
 * @param {object} options
 * @param {string} [options.externalsDir]  bundled binaries, if any
 * @returns {{blocking: string[], warnings: string[]}}
 */
export function checkRuntime({ externalsDir } = {}) {
  const blocking = [];
  const warnings = [];

  if (process.platform === "win32") {
    if (externalsDir && fs.existsSync(path.join(externalsDir, "git", "usr", "bin", "bash.exe"))) {
      // Bundled bash wins; nothing to check on the host.
    } else {
      const candidates = [
        path.join(process.env.ProgramFiles ?? "", "Git", "bin", "bash.exe"),
        path.join(process.env["ProgramFiles(x86)"] ?? "", "Git", "bin", "bash.exe"),
      ];
      const found = candidates.some((p) => p && fs.existsSync(p));
      if (!found) {
        blocking.push(
          "Git for Windows is required: Kady's agent runs every shell command " +
            "through Git Bash. Install it from https://git-scm.com/download/win " +
            "and restart the app.",
        );
      }
    }
  }

  if (process.platform === "darwin") {
    const env = runtimeEnvironment({ externalsDir });
    if (!executable("/bin/bash")) blocking.push("The system Bash shell (/bin/bash) is unavailable.");
    if (!runnable("git", env)) {
      blocking.push("Git is required. Install Apple Command Line Tools with `xcode-select --install` in Terminal, or install Git with Homebrew, then reopen Kady.");
    }
    if (!runnable("uv", env)) warnings.push("uv could not run. Reinstall Kady to restore its bundled Python environment manager.");
    return { blocking, warnings };
  }

  const uvBundled =
    externalsDir && fs.existsSync(path.join(externalsDir, "uv", "uv.exe"));
  if (!uvBundled && !onPath("uv")) {
    warnings.push(
      "uv was not found. Python tasks and scientific file previews will fail " +
        "until it is installed (https://docs.astral.sh/uv/).",
    );
  }

  return { blocking, warnings };
}

function onPath(name) {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, name + ext))) return true;
    }
  }
  return false;
}
