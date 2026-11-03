/**
 * Fetch the external binaries the backend shells out to, into build/externals/.
 *
 * Two of these are hard requirements the app cannot work without:
 *
 *  - bash: Pi's bash tool spawns a real bash.exe. On native Windows that means
 *    Git for Windows; MinGit is the portable subset (no installer, no GUI).
 *  - uv: every Python task in a project sandbox runs through `uv run`, and the
 *    preview helpers get their venv from `uv sync`.
 *
 * Everything is pinned by version and verified, because these are executables
 * that will run on the user's machine.
 *
 * Usage: node scripts/fetch-externals.mjs [--force]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const outDir = path.join(desktopRoot, "build", "externals");
const force = process.argv.includes("--force");

/** Pinned versions. Bump deliberately, after re-running the app once. */
const MINGIT = {
  version: "2.56.0.4",
  // PortableGit, not MinGit: MinGit ships git.exe but deliberately no
  // bash.exe, and bash is the binary Pi's tool layer spawns.
  // The asset is a 7z self-extractor; it accepts `-o<dir> -y` to unpack
  // silently, which keeps this dependency-free.
  url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe",
  mirrors: [
    "https://mirrors.tuna.tsinghua.edu.cn/github-release/git-for-windows/git/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe",
    "https://mirrors.tuna.tsinghua.edu.cn/github-release/git-for-windows/git/LatestRelease/PortableGit-2.56.0.4-64-bit.7z.exe",
  ],
  name: "portablegit.7z.exe",
  // Path inside the archive that must exist after extraction. bash lives in
  // usr/bin; the bin/bash.exe shim resolves relative to a tree we prune.
  expected: "usr/bin/bash.exe",
  /** Self-extracting 7z: run it with an output directory. */
  extract: (file, destDir) => {
    fs.mkdirSync(destDir, { recursive: true });
    const res = spawnSync(file, [`-o${destDir}`, "-y"], { stdio: "inherit" });
    if (res.status !== 0) throw new Error(`PortableGit self-extract failed: ${res.status}`);
    // PortableGit unpacks ~340 MB. The agent needs bash and git, nothing else;
    // the GUI toolchain, editor data and Perl/Mintty assets account for much of
    // it. Keep what `usr/bin/bash.exe` links against and drop the rest.
    for (const rel of pruneList(destDir)) {
      fs.rmSync(path.join(destDir, rel), { recursive: true, force: true });
    }
    // The bin/ and cmd/ shims resolve through the MinGW tree and usr; they only
    // work when the trees they point at exist, so verify the real executables.
    const mingw = mingwDir(destDir);
    for (const rel of ["usr/bin/bash.exe", `${mingw}/bin/git.exe`]) {
      if (!fs.existsSync(path.join(destDir, rel))) {
        throw new Error(`PortableGit is missing ${rel} after pruning`);
      }
    }
  },
};

/**
 * PortableGit 2.56 moved the toolchain from `mingw64` to `ucrt64`; older
 * archives still use `mingw64`. Detect rather than pin, so a version bump does
 * not silently break the bundle.
 */
function mingwDir(root) {
  for (const name of ["ucrt64", "mingw64"]) {
    if (fs.existsSync(path.join(root, name, "bin", "git.exe"))) return name;
  }
  throw new Error("PortableGit has neither ucrt64/bin/git.exe nor mingw64/bin/git.exe");
}

/**
 * Paths inside PortableGit that Kady never uses.
 *
 * The MinGW toolchain tree itself (`ucrt64/` or `mingw64/`) is NOT here: that
 * is git (git.exe plus the DLLs it links) and `libexec/git-core/`, which holds
 * the subcommands `git clone` shells out to. Dropping it leaves
 * `git: command not found`. What goes is the editor, the GUI history browsers,
 * the manual pages and the Vim/Perl runtime that only those tools need.
 */
function pruneList(root) {
  const mingw = mingwDir(root);
  return [
    "usr/share/vim", // editor runtime, ~23 MB of ex/vi/view aliases
    // The editor itself. Pruning only `share/vim` left six ~3.8 MB launchers
    // behind that nothing in Kady can invoke: they exist for a human who wants
    // to edit a file, which the agent does with its own tools.
    "usr/bin/vim.exe",
    "usr/bin/vimdiff.exe",
    "usr/bin/view.exe",
    "usr/bin/ex.exe",
    "usr/bin/rview.exe",
    "usr/bin/rvim.exe",
    "usr/bin/gvim.exe",
    "usr/bin/vimtutor.exe",
    "usr/bin/vimrun.exe",
    "usr/share/mintty", // terminal emulator for the GUI launchers
    "usr/share/doc",
    "usr/share/man",
    "usr/share/git-gui",
    "usr/share/gitk",
    "usr/share/perl5",
    "usr/lib/perl5",
    `${mingw}/share/doc`,
    `${mingw}/share/man`,
    `${mingw}/share/git-gui`,
    `${mingw}/share/gitk`,
    `${mingw}/doc`,
    `${mingw}/libexec/git-core/git-gui.exe`,
    `${mingw}/libexec/git-core/gitk.exe`,
    `${mingw}/libexec/git-core/git-gui`,
    `${mingw}/libexec/git-core/gitk`,
    `${mingw}/bin/git-gui.exe`,
    `${mingw}/bin/gitk.exe`,
    `${mingw}/bin/gitk`,
    `${mingw}/bin/wish.exe`,
    "git-bash.exe",
    "git-cmd.exe",
    "post-install.bat",
    "ReleaseNotes.html",
    "unins000.dat",
    "unins000.exe",
    "unins000.msg",
  ];
}

const UV = {
  version: "0.12.13",
  // The PyPI wheel ships the same uv.exe and is 17 MB instead of the 41 MB
  // GitHub archive; the Tsinghua mirror serves it without touching GitHub.
  url: "https://files.pythonhosted.org/packages/69/1b/f40b1ad51226c2ae8707aa124f3b31f9b176a00482048dadd42d9b953d1e/uv-0.12.13-py3-none-win_amd64.whl",
  mirrors: [
    "https://pypi.tuna.tsinghua.edu.cn/packages/69/1b/f40b1ad51226c2ae8707aa124f3b31f9b176a00482048dadd42d9b953d1e/uv-0.12.13-py3-none-win_amd64.whl",
  ],
  name: "uv.whl",
  // PyPI publishes the digest; a mismatch means a truncated or substituted file.
  sha256: "3efae0a910a25e18732f38ac1ef7b02e23f47b7fe67735039921fceff01d518c",
  expected: "uv.exe",
  /** A wheel is a zip; the exe sits inside a scripts/ directory. */
  extract: (file, destDir) => {
    fs.mkdirSync(destDir, { recursive: true });
    // Expand-Archive keys off the extension and rejects .whl.
    const zip = `${file}.zip`;
    fs.copyFileSync(file, zip);
    const staging = path.join(destDir, ".staging");
    try {
      unzip(zip, staging);
      const exe = findFile(staging, "uv.exe");
      if (!exe) throw new Error("uv.exe not found inside the wheel");
      fs.copyFileSync(exe, path.join(destDir, "uv.exe"));
    } finally {
      fs.rmSync(zip, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  },
};

/** Depth-first search for a file by name. */
function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

function log(msg) {
  console.log(msg);
}

async function download(spec, dest) {
  if (fs.existsSync(dest) && !force) {
    log(`  ${spec.name} already present, skipping`);
    return;
  }
  const candidates = [spec.url, ...(spec.mirrors ?? [])];
  let lastError = null;
  for (const url of candidates) {
    log(`  downloading ${spec.name} (${url})`);
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      // A proxy or error page would still be a 200; reject anything implausibly
      // small rather than staging a corrupt archive.
      if (bytes.length < 1_000_000) throw new Error(`suspiciously small (${bytes.length} bytes)`);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (spec.sha256 && sha !== spec.sha256) {
        throw new Error(`sha256 mismatch: expected ${spec.sha256}, got ${sha}`);
      }
      fs.writeFileSync(dest, bytes);
      log(`  ${spec.name}: ${(bytes.length / 1048576).toFixed(1)} MB, sha256 ${sha.slice(0, 16)}…`);
      return;
    } catch (error) {
      lastError = error;
      log(`    failed: ${error.message}`);
    }
  }
  throw new Error(`${spec.name}: every source failed (${lastError?.message})`);
}

/** Extract a .zip using the OS's own unzip support (Windows ships it). */
function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const res =
    process.platform === "win32"
      ? spawnSync("powershell", [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
        ])
      : spawnSync("unzip", ["-o", "-q", zipPath, "-d", destDir]);
  if (res.status !== 0) {
    throw new Error(`unzip failed: ${res.stderr?.toString() || res.status}`);
  }
}


const MAC_UV = {
  arm64: {
    url: "https://files.pythonhosted.org/packages/2a/33/ef14dc7c9c4cfaf0c3a4aed5a298b76b5dea94c75b233f7620c49c9b2e09/uv-0.12.13-py3-none-macosx_11_0_arm64.whl",
    sha256: "f86e5f02883c2e7a21bf522f4aa520c20d4f779d9a3368fbd6cdfe4a8f9549b5",
  },
  x64: {
    url: "https://files.pythonhosted.org/packages/7b/e9/de1916ac6602c226838aa1eee1033ce68138427399c63f9b47a5a1fa3dba/uv-0.12.13-py3-none-macosx_10_12_x86_64.whl",
    sha256: "ac7f135750b7419283029edb93453b4d41c7d7ff90f9b3860a6e474ddf98f016",
  },
};

async function stageMac() {
  const spec = MAC_UV[process.arch];
  if (!spec) throw new Error(`Unsupported macOS architecture: ${process.arch}`);
  fs.mkdirSync(outDir, { recursive: true });
  const downloads = path.join(desktopRoot, "build", "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  const archive = path.join(downloads, `uv-${process.arch}.zip`);
  await download({ ...spec, name: `uv-${process.arch}.zip` }, archive);
  // Verify cached downloads too; an interrupted or modified cache must fail.
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (digest !== spec.sha256) throw new Error("Cached macOS uv checksum mismatch; remove the archive and retry.");
  const staging = path.join(outDir, ".uv-staging");
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    unzip(archive, staging);
    const uv = findFile(staging, "uv");
    if (!uv) throw new Error("uv missing from macOS wheel");
    const dest = path.join(outDir, "uv");
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(uv, path.join(dest, "uv"));
    fs.chmodSync(path.join(dest, "uv"), 0o755);
    // Retain the wheel's third-party licence notices alongside the binary.
    for (const entry of fs.readdirSync(staging)) {
      if (entry.endsWith(".dist-info")) fs.cpSync(path.join(staging, entry), path.join(dest, entry), { recursive: true });
    }
    fs.writeFileSync(path.join(dest, ".version"), `${UV.version} ${process.arch}\n${spec.url}\n${spec.sha256}\n`);
    const bin = path.join(outDir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "node"), '#!/bin/sh\n: "${KADY_NODE_EXECUTABLE:?Kady runtime is not configured}"\nexport ELECTRON_RUN_AS_NODE=1\nexec "$KADY_NODE_EXECUTABLE" "$@"\n', { mode: 0o755 });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  console.log(`Staged macOS ${process.arch} uv and Node launcher. Git and Bash use the host.`);
}

async function main() {
  if (process.platform === "darwin") return stageMac();
  if (process.platform !== "win32") {
    log("Externals bundling is Windows-only for now; skipping.");
    log("macOS/Linux rely on the system bash, git and uv.");
    return;
  }

  log(`Staging externals into ${outDir}`);
  fs.mkdirSync(outDir, { recursive: true });

  // bash + git: one PortableGit tree serves both.
  const mingitDir = path.join(outDir, "git");
  if (force || !fs.existsSync(path.join(mingitDir, MINGIT.expected))) {
    const archive = path.join(outDir, MINGIT.name);
    await download(MINGIT, archive);
    log(`  extracting PortableGit`);
    MINGIT.extract(archive, mingitDir);
    fs.rmSync(archive, { force: true });
    if (!fs.existsSync(path.join(mingitDir, MINGIT.expected))) {
      throw new Error(`PortableGit extracted without ${MINGIT.expected}`);
    }
    fs.writeFileSync(
      path.join(mingitDir, ".version"),
      `${MINGIT.version}\n${MINGIT.url}\n`,
    );
  } else {
    log("  PortableGit already staged");
  }

  const uvDir = path.join(outDir, "uv");
  if (force || !fs.existsSync(path.join(uvDir, UV.expected))) {
    const archive = path.join(outDir, UV.name);
    await download(UV, archive);
    log(`  extracting uv`);
    UV.extract(archive, uvDir);
    fs.rmSync(archive, { force: true });
    if (!fs.existsSync(path.join(uvDir, UV.expected))) {
      throw new Error(`uv archive extracted without ${UV.expected}`);
    }
    fs.writeFileSync(path.join(uvDir, ".version"), `${UV.version}\n${UV.url}\n`);
  } else {
    log("  uv already staged");
  }

  const size = (dir) => {
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
  };
  log(`Done. git ${size(mingitDir)} MB, uv ${size(uvDir)} MB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
