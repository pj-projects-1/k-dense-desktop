import fs from "node:fs";
import path from "node:path";

// Explicitly follow nested links. Node's recursive cpSync can preserve nested
// directory links even with dereference:true (observed on Node 25/macOS), which
// leaves Next's traced dependencies pointing back to the build checkout.
export function copyRuntimeTree(from, to, { filter = () => true } = {}, ancestors = new Set()) {
  if (!filter(from, to)) return;
  const stat = fs.statSync(from);
  if (!stat.isDirectory()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return;
  }
  const real = fs.realpathSync(from);
  if (ancestors.has(real)) throw new Error(`Circular runtime dependency link: ${from}`);
  const next = new Set(ancestors).add(real);
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    copyRuntimeTree(path.join(from, name), path.join(to, name), { filter }, next);
  }
}
