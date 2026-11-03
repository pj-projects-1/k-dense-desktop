import fs from "node:fs";
import path from "node:path";
export default async function beforePack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const architecture = { 1: "x64", 3: "arm64" }[context.arch];
  if (!architecture || architecture !== process.arch) {
    throw new Error("Build each macOS architecture on a matching host; runtime dependencies and uv are architecture-specific.");
  }
  const root = path.resolve(import.meta.dirname, "..");
  const staged = JSON.parse(fs.readFileSync(path.join(root, "build/runtime/build-info.json"), "utf8"));
  if (staged.platform !== "darwin" || staged.arch !== architecture) throw new Error("Runtime payload architecture does not match the installer");
  const uv = fs.readFileSync(path.join(root, "build/externals/uv/.version"), "utf8");
  if (!uv.split("\n")[0].endsWith(` ${architecture}`)) throw new Error("uv architecture does not match the installer");
}
