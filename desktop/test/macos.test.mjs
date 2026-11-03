import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runtimeEnvironment, executable, portHelp } from "../runtime-env.mjs";

test("Finder environment discovers tools without evaluating shell startup files", () => {
  const env = runtimeEnvironment({ platform: "darwin", externalsDir: "/Applications/Kady App.app/Contents/Resources/externals", env: { HOME: "/Users/test", PATH: "/usr/bin:/bin" } });
  assert.equal(env.PATH.split(":")[0], "/Applications/Kady App.app/Contents/Resources/externals/bin");
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/Users/test/.local/bin", "/usr/bin", "/bin"]) assert.ok(env.PATH.split(":").includes(dir));
  assert.equal(env.SHELL, "/bin/bash");
  assert.equal(new Set(env.PATH.split(":")).size, env.PATH.split(":").length);
  assert.deepEqual(runtimeEnvironment({ platform: "win32", env: { PATH: "C:\\tools" } }), { PATH: "C:\\tools" });
});

test("executable check rejects non-executable files and directories", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-executable-"));
  try {
    const file = path.join(dir, "tool");
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    assert.equal(executable(file), false);
    assert.equal(executable(dir), false);
    fs.chmodSync(file, 0o755);
    assert.equal(executable(file), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("port diagnostics use the platform's tools", () => {
  assert.match(portHelp([8000], "darwin"), /lsof.*8000/);
  assert.doesNotMatch(portHelp([8000], "darwin"), /Task Manager/);
  assert.match(portHelp([8000], "win32"), /netstat.*8000/);
});

test("bundled node launcher handles paths and arguments containing spaces", { skip: process.platform !== "darwin" }, () => {
  const bin = path.resolve(import.meta.dirname, "../build/externals/bin");
  if (!fs.existsSync(path.join(bin, "node"))) throw new Error("Stage externals before running macOS tests");
  const result = spawnSync("/bin/bash", ["-c", `node -e 'console.log(process.argv[1])' "argument with spaces"`], {
    env: { PATH: `${bin}:/usr/bin:/bin`, KADY_NODE_EXECUTABLE: process.execPath }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "argument with spaces");
});
