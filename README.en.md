# K-Dense BYOK Desktop

**macOS fork:** See [Mac installation and build instructions](desktop/MACOS.md). Apple Silicon and Intel build targets are separate; consult the build report for tested coverage.

[English](README.en.md) | [简体中文](README.md)

Packages the two local services of [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok) into a single Windows desktop app. The installer bundles bash, git, uv and every Node dependency, so users install no runtime of their own.

For the upstream project's own documentation, see [README.upstream.md](README.upstream.md).

## Install

Download `Kady-<version>-x64-Setup.exe` from [Releases](https://github.com/YuEr159/k-dense-desktop/releases) and run it. The first launch creates the data directory under `%APPDATA%/Kady/`.

Windows shows a SmartScreen warning: the installer is not code-signed.

## Build from source

```bash
cd desktop
npm install
npm run dist
```

Produces `dist/Kady-<version>-x64-Setup.exe`.

> Behind a restricted network, use mirrors (direct GitHub access times out):
> ```bash
> cd desktop
> ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
> ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
> npx electron-builder --config electron-builder.json --win
> ```

`npm run dist` runs three steps: compile the payload (`build-runtime.mjs`), download and trim PortableGit and uv (`fetch-externals.mjs`), then package with electron-builder.

### Development mode (from source)

```bash
cd desktop && npm start
```

Requires `server/node_modules`, `web/node_modules` and `web/.next` to already exist (run `npx next build`).

### Test the packaged payload (no installer)

```bash
node desktop/scripts/build-runtime.mjs
node desktop/scripts/fetch-externals.mjs
node desktop/scripts/verify-externals.mjs   # PATH limited to bundled dirs, checks self-sufficiency
cd desktop && KADY_RUNTIME_DIR=./build/runtime npm start
```

### Run the packaged app (without installing)

```bash
./dist/win-unpacked/Kady.exe
```

## Architecture

```
Kady.exe
  ├─ app.asar              Shell code (main.mjs / service-manager.mjs / preflight.mjs)
  └─ resources/
       ├─ runtime/         Application payload
       │    ├─ server/src/**/*.mjs     Backend (compiled file by file, directory structure kept)
       │    ├─ server/node_modules/    438 production dependencies
       │    ├─ server/pi-packages/     Pi extension packages
       │    ├─ server/src/helpers/     Python decoders for scientific previews
       │    ├─ web/                    Next standalone output
       │    └─ models.json             Model price catalogue
       └─ externals/        Bundled binaries
```

The `version` in `desktop/package.json` determines the installer filename.

To release, tag `v<version>` and push; `release-desktop.yml` builds on a Windows runner and attaches the `.exe` to the Release.

## Verified

| Item | Result |
|---|---|
| `next build` standalone | Succeeds, runs independently |
| Payload starts on its own | `/health` 200, `/projects` 200 |
| Electron + payload (dev) | Window renders, UI 200 |
| **Packaged `Kady.exe`** | Window title correct, `/health` 200, UI 200 |
| Bundled bash runs commands | `BUNDLED_BASH_OK`, `git 2.56`, `uv 0.12.13`, exit 0 |
| **Isolated PATH check** | All 10 pass: bash / git / uv / pipes / heredoc / git init / HTTPS clone; `git` resolves inside the bundled directory |
| **Packaged build with network** | Isolated check re-run against the installed `externals/git`; `git ls-remote` returns remote branches |
| `shellPath` written | Points at the installed bash |
| Data directory | `%APPDATA%/Kady/data/` |
| `/tmp` usable | Temp file read/write works |
| Shutdown cleanup | No residual processes, ports released |

## Environment variables

| Variable | Purpose |
|---|---|
| `KADY_RUNTIME_DIR` | Points at the payload directory (`build/runtime`) |
| `KADY_DATA_ROOT` | Backend's writable root (injected by the shell) |
| `KADY_MODELS_CATALOGUE` | Path to the model catalogue JSON |
| `KADY_FRONTEND_PORT` | Frontend origin port the backend trusts (CORS) |

## Closing the window

By default, **closing the window sends the app to the tray** and the process keeps running. Background work — Modal jobs, scheduled runs — should not stop just because the window was dismissed; destroying the window also reclaims the renderer (~274 MB), dropping the resident footprint from roughly 750 MB to about 300 MB.

Double-click the tray icon to bring the window back; its context menu reopens the app or quits it outright. Settings → Appearance → System switches "on window close" to **Quit**, the classic behaviour: closing ends everything, and if work is in flight it asks first.

The data directory and ports are only released on quit. Under tray mode 3000/8000 stay bound — deliberately, or the next launch would find two backends.

## Chinese interface

The interface ships in Simplified Chinese by default (English when the browser language is not Chinese). Switch it under **Settings → Appearance → Language**.

Translation is done by **rewriting text at runtime**, not by wrapping components in `t()`. The upstream repository is the source of truth for this tree and we merge it regularly — every `t("...")` is a line upstream may also touch. Rewriting the DOM after render means the dictionary is the only file we own, upstream merges never conflict, and a string upstream renamed simply falls back to English: a visible degradation rather than a mistranslation.

Design notes, known gaps and how to add a translation are in [web/docs/i18n.md](web/docs/i18n.md).

## Not yet done

- **Code signing**: `signExecutable: false`, so Windows shows a SmartScreen warning
- **Auto-update**: upstream releases ship no binaries, so a version endpoint has to be built
- **First-launch Python environment**: `uv sync` builds two venvs (sandbox + preview helper); it takes several minutes and needs network
- **Skill library network dependency**: the `skills` CLI re-clones the upstream repo (460 MB) on every sync, and reports `SSL/TLS handshake` or `invalid index-pack output` when the network is unstable. System Git fails the same way with the same command, so this is not the bundled build's fault. Fetched caches land in `%TEMP%/kady-desk-skills/`, but the CLI does not reuse them
- **macOS**: this fork adds native packaging and bundled uv; see [macOS instructions](desktop/MACOS.md) for requirements and validation limits.
- **Linux**: configuration remains unverified; relies on system bash, git and uv.

## License

MIT. Based on [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok), Copyright K-Dense Inc.
