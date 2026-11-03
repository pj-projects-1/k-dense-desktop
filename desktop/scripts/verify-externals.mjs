/**
 * Verify the staged externals work without the host's help.
 *
 * A PATH that still contains the system's Git for Windows makes a broken
 * bundle look fine: bash falls back to /mingw64/bin/git from the host and every
 * check passes while a clean machine would fail. This runs the bundled shell
 * with a PATH containing only the bundle, so a missing component fails here
 * rather than on a user's machine.
 *
 * Usage: node scripts/verify-externals.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const externals = path.resolve(here, "..", "build", "externals");

if (!fs.existsSync(externals)) {
  console.error(`No staged externals at ${externals}; run fetch-externals.mjs first.`);
  process.exit(1);
}

if (process.platform === "darwin") {
  const uv = path.join(externals, "uv", "uv");
  const env = { PATH: `${path.join(externals, "bin")}:${path.dirname(uv)}:/usr/bin:/bin:/usr/sbin:/sbin`, KADY_NODE_EXECUTABLE: process.execPath };
  for (const [command, args] of [[uv, ["--version"]], ["/bin/bash", ["-c", 'git --version && node -e "console.log(process.arch)"']]]) {
    const result = spawnSync(command, args, { env, stdio: "inherit", timeout: 10000 });
    if (result.status !== 0) throw new Error(`macOS runtime check failed: ${command}`);
  }
  const result = spawnSync("/usr/bin/file", [uv], { encoding: "utf8" });
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  if (!result.stdout.includes(architecture)) throw new Error(`Wrong uv architecture: ${result.stdout}`);
  console.log("macOS uv, Node launcher, system Bash and Apple Git checks passed.");
  process.exit(0);
}

const gitRoot = path.join(externals, "git");
const bash = path.join(gitRoot, "usr", "bin", "bash.exe");
const uvExe = path.join(externals, "uv", "uv.exe");
// PortableGit 2.56 uses ucrt64/; older archives use mingw64/.
const mingw = ["ucrt64", "mingw64"].find((name) =>
  fs.existsSync(path.join(gitRoot, name, "bin", "git.exe")),
);

for (const [label, file] of [
  ["bash", bash],
  ["uv", uvExe],
  ["git", mingw ? path.join(gitRoot, mingw, "bin", "git.exe") : null],
]) {
  if (!file || !fs.existsSync(file)) {
    console.error(`missing ${label}: ${file ?? `no ucrt64/ or mingw64/ under ${gitRoot}`}`);
    process.exit(1);
  }
}

/**
 * Only the bundle is on PATH. System32 stays because Windows itself needs it
 * for process creation; nothing git-related comes from the host.
 */
const isolatedPath = [
  path.join(gitRoot, "cmd"),
  path.join(gitRoot, mingw, "bin"),
  path.join(gitRoot, "usr", "bin"),
  path.join(externals, "uv"),
  path.join(process.env.SystemRoot ?? "C:\\Windows", "system32"),
].join(path.delimiter);

const checks = [
  { name: "bash", cmd: "echo BASH_OK" },
  { name: "git", cmd: "git --version" },
  { name: "git resolves inside the bundle", cmd: "command -v git" },
  { name: "uv", cmd: "uv --version" },
  { name: "tmp is writable", cmd: "echo x > /tmp/kady-verify && cat /tmp/kady-verify && rm /tmp/kady-verify" },
  { name: "pipes", cmd: "echo abc | tr a-z A-Z" },
  { name: "heredoc", cmd: "cat <<EOF\nHEREDOC_OK\nEOF" },
  // The subcommands git shells out to live in libexec/git-core; a clone goes
  // through git-remote-https, which the self-extractor places there.
  { name: "git subcommands (clone-ready)", cmd: "git clone --help >/dev/null 2>&1 || git --exec-path" },
  { name: "git-remote-https present", cmd: "ls \"$(git --exec-path)/git-remote-https.exe\"" },
  { name: "git init + log", cmd: "cd /tmp && rm -rf kady-git-test && mkdir kady-git-test && cd kady-git-test && git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m t && git log --oneline" },
];

let failed = 0;
for (const check of checks) {
  const res = spawnSync(bash, ["-c", check.cmd], {
    env: { PATH: isolatedPath, HOME: process.env.USERPROFILE ?? "", SystemRoot: process.env.SystemRoot },
    encoding: "utf8",
    timeout: 60_000,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  const ok = res.status === 0 && !/command not found|fork bomb|BUG/i.test(out);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${check.name}${ok ? "" : `\n     ${out.split("\n").slice(0, 3).join("\n     ")}`}`);
  if (check.name === "git resolves inside the bundle" && ok) {
    // MSYS prints git as "/cmd/git" -- a path rooted at the bundle's own
    // mount, not a Windows path. Resolve it and compare against the staged
    // tree so a host installation cannot pass this check.
    const real = spawnSync(bash, ["-c", `cygpath -w "$(readlink -f "$(command -v git)")"`], {
      env: { PATH: isolatedPath, HOME: process.env.USERPROFILE ?? "", SystemRoot: process.env.SystemRoot },
      encoding: "utf8",
    });
    const resolved = (real.stdout ?? "").trim();
    if (!resolved.toLowerCase().startsWith(gitRoot.toLowerCase()) &&
        !resolved.toLowerCase().startsWith(fs.realpathSync(gitRoot).toLowerCase())) {
      console.log(`     resolves outside the bundle: ${resolved || out}`);
      failed += 1;
    }
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed: this bundle is not self-sufficient.`);
  process.exit(1);
}
console.log("\nAll checks passed with only the bundle on PATH.");
