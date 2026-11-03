import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { helperProjectDirectory, HELPERS_DIR } from "../src/helpers-env.ts";
const original = process.env.KADY_HELPERS_PROJECT_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.KADY_HELPERS_PROJECT_DIR;
  else process.env.KADY_HELPERS_PROJECT_DIR = original;
});
it("copies project metadata to writable storage without modifying shipped resources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-helper-project-"));
  try {
    process.env.KADY_HELPERS_PROJECT_DIR = dir;
    expect(helperProjectDirectory()).toBe(dir);
    for (const name of ["pyproject.toml", "uv.lock"]) {
      expect(fs.readFileSync(path.join(dir, name))).toEqual(fs.readFileSync(path.join(HELPERS_DIR, name)));
    }
    fs.writeFileSync(path.join(dir, "uv.lock"), "stale local lock");
    helperProjectDirectory();
    expect(fs.readFileSync(path.join(dir, "uv.lock"))).toEqual(fs.readFileSync(path.join(HELPERS_DIR, "uv.lock")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it("source mode retains the existing helper location", () => {
  delete process.env.KADY_HELPERS_PROJECT_DIR;
  expect(helperProjectDirectory()).toBe(HELPERS_DIR);
});
