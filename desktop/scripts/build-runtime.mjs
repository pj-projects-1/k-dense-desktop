/**
 * Stage the runtime payload for a packaged desktop build.
 *
 * The backend is not bundled into one file: several modules resolve their own
 * neighbours at runtime (`import.meta.dirname` -> ../../pi-packages,
 * ../../node_modules/.bin, ./subagent-host.mjs, ../helpers), so the shipped
 * tree must keep server/src and server/pi-packages intact. Instead of fighting
 * those paths, we compile src/**\/*.ts to .mjs in place and carry the package
 * tree, pi-packages, helpers and the model catalogue alongside.
 *
 * Usage: node scripts/build-runtime.mjs [--out <dir>]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";
import { copyRuntimeTree } from "./runtime-files.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const serverRoot = path.join(repoRoot, "server");

const outArg = process.argv.indexOf("--out");
const outDir = path.resolve(
  outArg !== -1 && process.argv[outArg + 1]
    ? process.argv[outArg + 1]
    : path.join(desktopRoot, "build", "runtime"),
);
const serverOut = path.join(outDir, "server");
const webOut = path.join(outDir, "web");

function rmrf(dir) {
  // Windows keeps handles open a moment after a process exits; a silent
  // failure here leaves the previous tree in place and the new payload merges
  // into it, which is how a stale .venv once shipped.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      return;
    } catch (error) {
      if (attempt === 4) throw new Error(`could not clear ${dir}: ${error.message}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
}

function copyDir(from, to, options = {}) {
  copyRuntimeTree(from, to, options);
}

/** Copy a directory tree, skipping any path segment in `skip`. */
function copyDirSkipping(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirSkipping(src, dst, skip);
    else fs.copyFileSync(src, dst);
  }
}

/**
 * Should this path inside a dependency be left out of the payload?
 *
 * The installer's cost is dominated by file count, not bytes: 31k files in
 * `node_modules` and every one of them gets created, written and scanned by
 * antivirus on the user's machine. These classes are the ones a running
 * dependency never reads.
 *
 *  - `.map` — read only by a debugger attached to third-party code.
 * Markdown is deliberately retained: Pi packages load prompts, agents and
 * skills from Markdown at runtime; these are not merely documentation.
 *  - Test files — `__tests__/` directories and `*.test.*` / `*.spec.*`. A
 *    package's top-level `test/` is *not* dropped even though it usually holds
 *    only tests: a few older packages keep fixtures there that runtime code
 *    reads, and the whole point of this filter is to be safe.
 */
const OMITTED_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

function omitFromBundle(src) {
  const base = path.basename(src);
  const stat = fs.statSync(src, { throwIfNoEntry: false });
  if (stat?.isDirectory()) return base === "__tests__";
  if (base.endsWith(".map")) return true;
  return OMITTED_TEST_FILE.test(base);
}

/** Every .ts/.mts under `dir`, paired with its compiled output path. */
function sourceFiles(dir, outRoot = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full, outRoot));
      continue;
    }
    if (!/\.(ts|mts)$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
    const rel = path.relative(outRoot, full);
    out.push({ from: full, to: path.join(outRoot, rel.replace(/\.(ts|mts)$/, ".mjs")) });
  }
  return out;
}

/** Copy non-TypeScript files under server/src (e.g. subagent-host.mjs). */
function copySrcAssets(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "helpers") continue; // handled separately (skips .venv)
      copySrcAssets(src, dst);
      continue;
    }
    if (/\.(ts|mts)$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
    fs.copyFileSync(src, dst);
  }
}

async function buildBackend() {
  fs.mkdirSync(serverOut, { recursive: true });

  // 1. Compile server/src/**/*.ts -> .mjs next to their sources, keeping the
  //    relative layout the runtime paths depend on.
  const srcDir = path.join(serverRoot, "src");
  const files = sourceFiles(srcDir);
  for (const file of files) {
    const rel = path.relative(serverRoot, file.from);
    const out = path.join(serverOut, rel.replace(/\.(ts|mts)$/, ".mjs"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await esbuild({
      entryPoints: [file.from],
      outfile: out,
      bundle: false,
      platform: "node",
      format: "esm",
      target: "node22",
      // Keep every import specifier as written: the tree that satisfies them
      // is staged beside this file.
      packages: "external",
      loader: { ".ts": "ts" },
      logLevel: "silent",
    });
  }

  // 2. Rewrite .ts import specifiers to .mjs in the emitted files. Sources use
  //    explicit .ts extensions (Node's type stripping requires them) and some
  //    build paths by hand ("agents/<id>/index.ts"); compiled output is .mjs.
  for (const file of files) {
    const rel = path.relative(serverRoot, file.from);
    const out = path.join(serverOut, rel.replace(/\.(ts|mts)$/, ".mjs"));
    const text = fs.readFileSync(out, "utf8");
    const rewritten = text
      // import/export ... from "./x.ts" -> .mjs
      .replace(/(\bfrom\s*["'][^"']+)\.ts(["'])/g, "$1.mjs$2")
      // bare side-effect imports: import "./x.ts"
      .replace(/(\bimport\s*["'][^"']+)\.ts(["'])/g, "$1.mjs$2")
      // runtime strings naming a module path (pi-packages/<id>/index.ts)
      .replace(/(["'][^"']*\/index)\.ts(["'])/g, "$1.mjs$2");
    fs.writeFileSync(out, rewritten);
  }

  // Non-TS assets under src: subagent-host.mjs is resolved by path at
  // runtime, and the helper scripts land here too.
  copySrcAssets(srcDir, path.join(serverOut, "src"));

  // The Python helpers, minus the per-machine .venv.
  // .venv is a per-machine environment rebuilt by `uv sync` on first run: it
  // is hundreds of MB and must never ship.
  copyDirSkipping(
    path.join(srcDir, "helpers"),
    path.join(serverOut, "src", "helpers"),
    new Set([".venv", "__pycache__"]),
  );

  // 2b. The backend imports shared logic straight out of web/src/lib
  //     ("../../../web/src/lib/..."). Those must be compiled too, or the
  //     emitted ../../../web/src/lib/x.mjs does not exist. Compile the closure
  //     of files the backend actually reaches, preserving relative layout.
  const sharedSources = new Map(); // absolute source path -> relative to repo
  const seen = new Set();
  const collect = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    sharedSources.set(file, path.relative(repoRoot, file).replaceAll("\\", "/"));
    // Relative .ts imports inside the shared files pull in more shared files.
    for (const m of text.matchAll(/from\s*["'](\.[^"']+)\.ts["']/g)) {
      const next = path.resolve(path.dirname(file), m[1] + ".ts");
      if (fs.existsSync(next)) collect(next);
    }
  };
  for (const file of files) {
    const text = fs.readFileSync(file.from, "utf8");
    for (const m of text.matchAll(/["'](\.[^"']*web\/src\/[^"']+\.ts)["']/g)) {
      const target = path.resolve(path.dirname(file.from), m[1]);
      if (fs.existsSync(target)) collect(target);
    }
  }
  for (const [src, rel] of sharedSources) {
    const out = path.join(outDir, rel.replace(/\.ts$/, ".mjs"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await esbuild({
      entryPoints: [src],
      outfile: out,
      bundle: false,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      loader: { ".ts": "ts" },
      logLevel: "silent",
    });
    const text = fs.readFileSync(out, "utf8");
    // web/src modules import each other without extensions (the Next bundler
    // resolves that; Node's ESM loader does not). Add .mjs when the target
    // exists as a compiled sibling.
    const withExtensions = text.replace(
      /(\bfrom\s*["'])(\.\.?\/[^"'.][^"']*)(["'])/g,
      (m, lead, spec, quote) => {
        if (/\.(mjs|js|json|css)$/.test(spec)) return m;
        const abs = path.resolve(path.dirname(out), spec);
        if (fs.existsSync(abs + ".mjs")) return `${lead}${spec}.mjs${quote}`;
        if (fs.existsSync(path.join(abs, "index.mjs"))) return `${lead}${spec}/index.mjs${quote}`;
        return m;
      },
    );
    fs.writeFileSync(
      out,
      withExtensions
        .replace(/(\bfrom\s*["'][^"']+)\.ts(["'])/g, "$1.mjs$2")
        .replace(/(\bimport\s*["'][^"']+)\.ts(["'])/g, "$1.mjs$2"),
    );
  }
  if (sharedSources.size) console.log(`  compiled ${sharedSources.size} shared web/src modules`);

  // 3. Files the backend imports from outside server/: the launcher's shared
  //    .env parser sits at the repo root and is imported as ../../env-file.mjs.
  fs.copyFileSync(path.join(repoRoot, "env-file.mjs"), path.join(outDir, "env-file.mjs"));

  // 4. Extension packages: the .ts sources stay (Pi's loader reads them via
  //    package.json "pi.extensions"), and a compiled .mjs sibling is emitted
  //    because the backend imports several of them by path and Node cannot
  //    load .ts directly.
  copyDir(path.join(serverRoot, "pi-packages"), path.join(serverOut, "pi-packages"));
  let piCompiled = 0;
  for (const pkgDir of fs.readdirSync(path.join(serverRoot, "pi-packages"))) {
    const srcPkg = path.join(serverRoot, "pi-packages", pkgDir);
    if (!fs.statSync(srcPkg).isDirectory()) continue;
    for (const file of sourceFiles(srcPkg)) {
      const rel = path.relative(srcPkg, file.from).replace(/\.(ts|mts)$/, ".mjs");
      const out = path.join(serverOut, "pi-packages", pkgDir, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await esbuild({
        entryPoints: [file.from],
        outfile: out,
        bundle: false,
        platform: "node",
        format: "esm",
        target: "node22",
        packages: "external",
        loader: { ".ts": "ts" },
        logLevel: "silent",
      });
      const text = fs.readFileSync(out, "utf8");
      fs.writeFileSync(
        out,
        text
          .replace(/(\bfrom\s*["'][^"']+)\.ts(["'])/g, "$1.mjs$2")
          .replace(/(\bimport\s*["'][^"']+)\.ts(["'])/g, "$1.mjs$2"),
      );
      piCompiled += 1;
    }
  }
  console.log(`  compiled ${piCompiled} pi-package modules`);
  copyDir(path.join(serverRoot, "scripts"), path.join(serverOut, "scripts"));

  // 5. Dependencies. `server/package.json` lists direct dependencies, but the
  //    tree they resolve against (chalk, undici, ...) is the full install. Use
  //    the lockfile's own record of what is a production package so dev
  //    tooling (tsx, vitest, typescript) is what gets dropped, not transitives.
  const pkg = JSON.parse(fs.readFileSync(path.join(serverRoot, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(serverRoot, "package-lock.json"), "utf8"));
  const stagedNm = path.join(serverOut, "node_modules");
  fs.mkdirSync(stagedNm, { recursive: true });

  // lock.packages keys are "node_modules/<name>" or "node_modules/<a>/node_modules/<b>".
  // `dev: true` marks development-only packages; everything else ships.
  let copied = 0;
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith("node_modules/")) continue;
    if (meta.dev === true) continue; // installed optional packages include native runtime binaries
    const rel = key.slice("node_modules/".length);
    const from = path.join(serverRoot, key);
    if (!fs.existsSync(path.join(from, "package.json"))) continue;
    const to = path.join(stagedNm, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    copyDir(from, to, {
      filter: (src) => {
        if (src === from) return true;
        try {
          return !omitFromBundle(src);
        } catch {
          // A broken symlink or a file vanishing mid-copy: keep whatever comes
          // next rather than failing the build over one weird package.
          return true;
        }
      },
    });
    copied += 1;
  }
  console.log(`  staged ${copied} production packages`);

  // The backend prepends node_modules/.bin to PATH for the tools it shells
  // out to; recreate the shims from each package's own `bin` field.
  const binDir = path.join(stagedNm, ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const key of Object.keys(lock.packages ?? {})) {
    if (!key.startsWith("node_modules/")) continue;
    const rel = key.slice("node_modules/".length);
    const pkgJson = path.join(stagedNm, rel, "package.json");
    if (!fs.existsSync(pkgJson)) continue;
    const meta = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
    const bins =
      typeof meta.bin === "string" ? { [meta.name.split("/").pop()]: meta.bin } : meta.bin;
    if (!bins) continue;
    for (const [binName, target] of Object.entries(bins)) {
      if (process.platform !== "win32") {
        const destination = path.resolve(stagedNm, rel, target);
        if (!fs.existsSync(destination)) continue;
        const shim = path.join(binDir, binName);
        // Relative links survive moving the app; retain executable permissions.
        if (!fs.existsSync(shim)) fs.symlinkSync(path.relative(binDir, destination), shim);
        fs.chmodSync(destination, fs.statSync(destination).mode | 0o111);
        continue;
      }
      const shim = path.join(binDir, `${binName}.cmd`);
      const depth = rel.split("/").length;
      const back = Array(depth).fill("..").join("\\");
      fs.writeFileSync(
        shim,
        `@echo off\r\n"%~dp0\\${back}\\${rel.replaceAll("/", "\\")}\\${target.replaceAll("/", "\\")}" %*\r\n`,
      );
    }
  }

  fs.writeFileSync(
    path.join(serverOut, "package.json"),
    JSON.stringify({ name: "kady-server", version: pkg.version, type: "module", private: true }, null, 2),
  );
}

function buildFrontend() {
  const standalone = path.join(repoRoot, "web", ".next", "standalone");
  if (!fs.existsSync(path.join(standalone, "server.js"))) {
    throw new Error(
      "Next standalone build missing. Run `cd web && npx next build` with " +
        '`output: "standalone"` in next.config.ts first.',
    );
  }
  copyDir(standalone, webOut);
  // Next's standalone output deliberately omits these two; it expects the
  // deployer to place them beside server.js.
  const staticSrc = path.join(repoRoot, "web", ".next", "static");
  if (fs.existsSync(staticSrc)) copyDir(staticSrc, path.join(webOut, ".next", "static"));
  const publicSrc = path.join(repoRoot, "web", "public");
  if (fs.existsSync(publicSrc)) copyDir(publicSrc, path.join(webOut, "public"));
}

function copyModelsCatalogue() {
  const src = path.join(repoRoot, "web", "src", "data", "models.json");
  fs.copyFileSync(src, path.join(outDir, "models.json"));
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else total += fs.statSync(q).size;
    }
  };
  walk(dir);
  return (total / 1048576).toFixed(1);
}

async function main() {
  console.log(`Staging runtime into ${outDir}`);
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  await buildBackend();
  buildFrontend();
  copyModelsCatalogue();
  fs.writeFileSync(path.join(outDir, "build-info.json"), JSON.stringify({ platform: process.platform, arch: process.arch }) + "\n");

  // Guard against the failure mode where a stale per-machine environment is
  // carried into the payload: it is hundreds of MB and must be rebuilt by
  // `uv sync` on the user's machine instead.
  const venv = path.join(serverOut, "src", "helpers", ".venv");
  if (fs.existsSync(venv)) {
    throw new Error(`refusing to ship a Python environment: ${venv}`);
  }

  console.log(`Done. server ${dirSize(serverOut)} MB, web ${dirSize(webOut)} MB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
