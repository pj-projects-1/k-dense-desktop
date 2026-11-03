/**
 * Service manager for the desktop shell.
 *
 * Two modes:
 *  - dev: run the checkout directly (tsx for the backend, `next start` for the
 *    frontend), same as stage 0.
 *  - packaged: run the prebuilt artifacts shipped inside the app — a compiled
 *    backend bundle and the Next standalone server — with all writable state
 *    redirected to the per-user data directory.
 *
 * `ELECTRON_RUN_AS_NODE=1` makes electron.exe behave as a plain Node runtime.
 * It is set for our children *and* inherited by theirs, which is what keeps the
 * backend's own `spawn(process.execPath, ...)` calls (pi mcp, skills CLI)
 * working without patching them.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { runtimeEnvironment, portHelp } from "./runtime-env.mjs";

export const BACKEND_PORT = process.platform === "darwin" ? 47821 : 8000;
export const FRONTEND_PORT = process.platform === "darwin" ? 47822 : 3000;
export const UI_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

const children = new Set();
// Keep group ownership even if a service leader crashes before app shutdown.
const processGroups = new Set();
let shuttingDown = false;
let fatalHandler = null;

/**
 * Random per-launch token the backend echoes from `/health`.
 *
 * Waiting for the URL to answer is not enough: if another program (a dev
 * server, a second copy of the app) already listens on the port, our own child
 * dies with EADDRINUSE and the probe still succeeds against *that* program.
 * The window then opens against someone else's backend — usually one whose
 * projects directory is elsewhere, so the UI sits on "Loading" forever with no
 * error anywhere. Matching this token proves the reply came from the process we
 * started.
 */
const LAUNCH_TOKEN = crypto.randomUUID();

/** Set once a startup-time child exits; checked by the readiness loop. */
let childFailure = null;

/** Set when a port is closed but answered by a process we did not spawn. */
let portConflict = null;

/** Flips once startServices() has both services answering. */
let servicesReady = false;

function consumeStartupProblem() {
  const problem = childFailure
    ? { kind: "child", ...childFailure }
    : portConflict
      ? { kind: "port", label: portConflict }
      : null;
  childFailure = null;
  portConflict = null;
  return problem;
}

/** Repo root: the desktop/ directory sits directly under it. */
export const repoRoot = path.resolve(import.meta.dirname, "..");

export function setFatalHandler(handler) {
  fatalHandler = handler;
}

function nodeEnv(extra = {}) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    ...extra,
  };
}

function spawnService(label, file, args, cwd, env) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd,
    env: nodeEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  children.add(child);
  if (process.platform !== "win32" && child.pid) processGroups.add(child.pid);

  const forward = (stream, sink) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => sink(chunk.trimEnd()));
  };
  forward(child.stdout, (line) => console.log(`[${label}] ${line}`));
  forward(child.stderr, (line) => console.error(`[${label}] ${line}`));

  child.once("error", (err) => {
    console.error(`[${label}] failed to start: ${err.message}`);
    if (!shuttingDown && !childFailure) childFailure = { label, message: err.message };
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown && process.platform !== "win32" && child.pid) {
      // Retire a crashed leader's group immediately, before its ID can be reused.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* group exited */ }
      processGroups.delete(child.pid);
    }
    if (!shuttingDown) {
      console.error(`[${label}] exited (code=${code} signal=${signal})`);
      // During startup this is the difference between "the window opens onto a
      // working app" and "the window opens onto nothing". Record it so the
      // readiness loop can fail immediately and report which service died
      // instead of polling a port some other program may be answering on.
      if (!childFailure && !servicesReady) {
        childFailure = { label, code, signal };
      }
      fatalHandler?.();
    }
  });
  return child;
}

/**
 * Is something already listening on `port`?
 *
 * Checked *before* spawning: our child would otherwise die with EADDRINUSE a
 * second later, and the failure used to surface as a successful startup
 * against the other program. Probing first lets the shell name the port and
 * say what to do about it.
 */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

/**
 * Environment shared by both services. `dataRoot` is where every writable
 * path lands: `.env` with saved API keys and `projects/` with user data.
 *
 * `externalsDir` holds the binaries we ship (MinGit's bash + git, uv). They go
 * on PATH ahead of anything the user has, and Pi is told explicitly which bash
 * to use -- a missing bash.exe breaks every agent tool call, so this must not
 * depend on the user's PATH.
 */
function commonEnv(dataRoot, modelsCatalogue, externalsDir) {
  const env = {
    ...runtimeEnvironment({ externalsDir }),
    KADY_NODE_EXECUTABLE: process.execPath,
    KADY_HOST: "127.0.0.1",
    HOSTNAME: "127.0.0.1",
    PORT: String(FRONTEND_PORT),
    KADY_DATA_ROOT: dataRoot,
    KADY_PORT: String(BACKEND_PORT),
    KADY_FRONTEND_PORT: String(FRONTEND_PORT),
    // The helper venv is ~555 MB of Python packages built by `uv sync`. Left in
    // the payload (uv's default, beside pyproject.toml) an upgrade would wipe
    // it: NSIS replaces the install directory wholesale. Keep it in the data
    // root, which survives upgrades and is already the user's writable area.
    KADY_HELPERS_VENV: path.join(dataRoot, "python", "helpers"),
    KADY_HELPERS_PROJECT_DIR: path.join(dataRoot, "python", "helper-project"),
  };
  if (modelsCatalogue) env.KADY_MODELS_CATALOGUE = modelsCatalogue;

  if (externalsDir && process.platform === "win32") {
    const gitRoot = path.join(externalsDir, "git");
    // PortableGit 2.56 ships the toolchain as ucrt64/; older archives use
    // mingw64/. Both put the real git.exe there and a shim under cmd/.
    const mingw = ["ucrt64", "mingw64"].find((name) =>
      fs.existsSync(path.join(gitRoot, name, "bin", "git.exe")),
    );
    const gitBin = path.join(gitRoot, "cmd");
    const gitUsrBin = path.join(gitRoot, "usr", "bin");
    const uvBin = path.join(externalsDir, "uv");
    // The MinGW bin carries the DLLs git.exe links; cmd/ and usr/bin carry the
    // shims and bash. All three go on PATH ahead of the user's own tools.
    const mingwBin = mingw ? path.join(gitRoot, mingw, "bin") : null;
    const parts = [gitBin, gitUsrBin, mingwBin, uvBin].filter((p) => p && fs.existsSync(p));
    if (parts.length) {
      env.PATH = [...parts, process.env.PATH ?? ""].join(path.delimiter);
      // Kady looks for uv on PATH first, then ~/.local/bin; putting the bundled
      // copy on PATH is enough, but this makes the intent explicit.
      const uvExe = path.join(uvBin, "uv.exe");
      if (fs.existsSync(uvExe)) env.UV = uvExe;
    }
    // Pi resolves bash as: settings.shellPath, then Program Files\Git, then
    // PATH (see getShellConfig in pi-coding-agent). Writing shellPath into the
    // shared agent settings is what makes the bundled bash win over an old
    // system Git -- a wrong bash here breaks every agent tool call.
    const bashExe = path.join(externalsDir, "git", "usr", "bin", "bash.exe");
    if (fs.existsSync(bashExe)) configureShellPath(env, bashExe);
  }
  return env;
}

/**
 * Point Pi at a specific bash via its own settings file. Existing user
 * settings are preserved: the key is only added when absent, and an
 * unparseable file is left untouched.
 *
 * Kady's backend resolves its agent directory in env.ts from
 * PI_CODING_AGENT_DIR / KADY_PI_AGENT_DIR, defaulting to ~/.kady/pi-agent.
 * The same resolution is repeated here so the settings land where the backend
 * will look for them.
 */
function configureShellPath(env, bashExe) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  let configured =
    env.PI_CODING_AGENT_DIR?.trim() ||
    env.KADY_PI_AGENT_DIR?.trim() ||
    path.join(home, ".kady", "pi-agent");
  // Expand a leading ~ the way Kady's env.ts does.
  if (configured === "~") configured = home;
  else if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    configured = path.join(home, configured.slice(2));
  }
  const agentDir = path.resolve(configured);
  const settingsPath = path.join(agentDir, "settings.json");
  try {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return;
      settings = parsed;
      if (settings.shellPath === bashExe) return; // already ours
      // Keep a shellPath the user chose -- unless it points somewhere that no
      // longer exists, which is what a moved/reinstalled app leaves behind.
      if (typeof settings.shellPath === "string" && settings.shellPath.trim()) {
        if (fs.existsSync(settings.shellPath)) return;
        console.log(`[shell] replacing stale shellPath: ${settings.shellPath}`);
      }
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ ...settings, shellPath: bashExe }, null, 2) + "\n",
    );
    console.log(`[shell] pinned bash for the agent: ${bashExe}`);
  } catch (error) {
    // Never block startup on this: Pi falls back to its own discovery.
    console.warn(`[shell] could not record shellPath: ${error.message}`);
  }
}

/**
 * Packaged builds read prebuilt artifacts from resources/runtime/. A source
 * checkout has none, so `startServices` falls back to tsx + `next start`.
 */
export function packagedArtifacts(resourcesPath) {
  const runtime = path.join(resourcesPath, "runtime");
  const backendEntry = path.join(runtime, "server", "src", "index.mjs");
  const standaloneDir = path.join(runtime, "web");
  if (!fs.existsSync(backendEntry) || !fs.existsSync(path.join(standaloneDir, "server.js"))) {
    return null;
  }
  return {
    backendBundle: backendEntry,
    standaloneDir,
    modelsCatalogue: path.join(runtime, "models.json"),
    externalsDir: path.join(resourcesPath, "externals"),
  };
}

/** Source checkout: run TypeScript through tsx exactly like the repo does. */
function startBackendFromSource(env) {
  return spawnService(
    "backend",
    path.join(repoRoot, "server", "node_modules", "tsx", "dist", "cli.mjs"),
    [path.join(repoRoot, "server", "src", "index.ts")],
    path.join(repoRoot, "server"),
    env,
  );
}

/** Packaged: the compiled tree staged by scripts/build-runtime.mjs. */
function startBackendFromBundle(bundlePath, env) {
  // index.mjs sits in src/, and the runtime resolves ../../pi-packages,
  // ../../node_modules, and ../../env-file.mjs from there.
  return spawnService("backend", bundlePath, [], path.dirname(bundlePath), env);
}

function startFrontendFromSource(env) {
  return spawnService(
    "frontend",
    path.join(repoRoot, "web", "node_modules", "next", "dist", "bin", "next"),
    ["start", "-p", String(FRONTEND_PORT), "-H", "127.0.0.1"],
    path.join(repoRoot, "web"),
    env,
  );
}

/** Packaged: Next standalone's own server.js, no node_modules needed. */
function startFrontendFromStandalone(standaloneDir, env) {
  return spawnService(
    "frontend",
    path.join(standaloneDir, "server.js"),
    [],
    standaloneDir,
    env,
  );
}

/**
 * Does this `/health` body come from the backend we started?
 *
 * Exported so the startup tests can check the rule directly. A reply without a
 * token, or with a different one, belongs to another program on the port.
 */
export function healthBelongsToLaunch(body, expected = LAUNCH_TOKEN) {
  return Boolean(body) && body.launchToken === expected;
}

async function waitFor(url, label, timeoutMs, { expectToken = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    if (childFailure) {
      const { label: failed, code, message } = childFailure;
      console.error(
        `[${label}] aborting: ${failed} exited during startup ` +
          (message ? `(${message})` : `(code=${code}).`),
      );
      return false;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) {
        // Something answered, but not a healthy instance. Keep waiting: our own
        // child may simply not be listening yet.
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (expectToken) {
        const body = await res.json().catch(() => null);
        if (!healthBelongsToLaunch(body)) {
          // A server is up on our port, but it is not the one we started.
          portConflict = label;
          console.error(
            `[${label}] port ${BACKEND_PORT} is answered by another process ` +
              `(no launch token); refusing to treat it as ready.`,
          );
          return false;
        }
      }
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.error(`[${label}] did not answer ${url} within ${Math.round(timeoutMs / 1000)}s`);
  return false;
}

/**
 * @param {object} options
 * @param {string} options.dataRoot  writable state directory
 * @param {string} [options.externalsDir]  bundled bash/git/uv (packaged)
 * @param {string} [options.backendBundle]  compiled backend entry (packaged)
 * @param {string} [options.standaloneDir]  Next standalone dir (packaged)
 * @param {string} [options.modelsCatalogue]  models.json path (packaged)
 */
export async function startServices({
  dataRoot,
  externalsDir,
  backendBundle,
  standaloneDir,
  modelsCatalogue,
}) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const env = commonEnv(dataRoot, modelsCatalogue, externalsDir);
  // The backend echoes this from /health so the readiness probe can tell our
  // child apart from whatever else might already own the port.
  env.KADY_LAUNCH_TOKEN = LAUNCH_TOKEN;

  // Refuse to start onto an occupied port. Spawning anyway would kill our own
  // child (EADDRINUSE) while leaving the other program answering, which is the
  // failure this whole check exists to prevent.
  const busy = [];
  if (await portInUse(BACKEND_PORT)) busy.push(BACKEND_PORT);
  if (await portInUse(FRONTEND_PORT)) busy.push(FRONTEND_PORT);
  if (busy.length) {
    const ports = busy.join(" and ");
    const detail =
      `Port ${ports} ${busy.length > 1 ? "are" : "is"} already in use, so Kady's own ` +
      `service could not start.\n\n` +
      `This is usually another copy of Kady, a development server, or a ` +
      `program left running in the background. Close it and start Kady again.\n\n` +
      portHelp(busy);
    console.error(`[startup] ${ports} already in use`);
    return { ok: false, detail };
  }

  if (backendBundle && standaloneDir) {
    startBackendFromBundle(backendBundle, env);
    startFrontendFromStandalone(standaloneDir, env);
  } else {
    startBackendFromSource(env);
    startFrontendFromSource(env);
  }

  const backendUp = await waitFor(`${BACKEND_URL}/health`, "backend", 120_000, {
    expectToken: true,
  });
  const frontendUp = backendUp
    ? await waitFor(`${UI_URL}/`, "frontend", 180_000)
    : false;

  if (backendUp && frontendUp) {
    servicesReady = true;
    return { ok: true };
  }

  const problem = consumeStartupProblem();
  return { ok: false, detail: describeStartupProblem(problem) };
}

/** Turn a recorded startup failure into something a user can act on. */
function describeStartupProblem(problem) {
  if (!problem) {
    return (
      "A local service did not become ready in time.\n\n" +
      "The application log has the details. Common causes are a slow disk on " +
      "first launch, antivirus scanning the install directory, or an " +
      "incomplete installation — reinstalling usually clears the last one."
    );
  }
  if (problem.kind === "port") {
    return (
      `Port ${BACKEND_PORT} was answered by a program Kady did not start, so ` +
      `the window would have shown someone else's data.\n\n` +
      portHelp([BACKEND_PORT])
    );
  }
  const why = problem.message ?? `exit code ${problem.code}`;
  const hint =
    problem.label === "backend"
      ? "The backend's own message is in the application log (Help → Open logs)."
      : "The frontend's own message is in the application log (Help → Open logs).";
  return `Kady's ${problem.label} stopped during startup (${why}).\n\n${hint}`;
}

export async function stopServices() {
  if (shuttingDown) return;
  shuttingDown = true;

  const alive = [...children];
  for (const pid of processGroups) {
    try { process.kill(-pid, "SIGTERM"); } catch { /* group exited */ }
  }
  for (const child of alive) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      }
    } catch {
      /* already gone */
    }
  }
  const done = Promise.all(
    alive.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.once("exit", r)))),
  );
  let deadline;
  await Promise.race([done, new Promise((r) => { deadline = setTimeout(r, 5000); })]);
  clearTimeout(deadline);
  // Descendants can outlive a service leader; kill the isolated group even
  // after the leader exits. Never target the desktop process group.
  if (process.platform !== "win32") {
    for (const pid of processGroups) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* group exited */ }
    }
  }
  children.clear();
  processGroups.clear();
}
