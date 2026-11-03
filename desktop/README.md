# K-Dense BYOK 桌面版

Electron 壳，把 K-Dense BYOK 的两个本地服务装进一个窗口。Windows 打包产物自带 bash、git、uv，用户无需安装任何运行时。

## 快速开始

### 运行打包后的应用

```bash
./dist/win-unpacked/Kady.exe
```

### 生成安装包

```bash
cd desktop
npm install
npm run dist
```

产出 `dist/Kady-<version>-x64-Setup.exe`。

> 网络受限时需要镜像（GitHub 直连会超时）：
> ```bash
> cd desktop
> ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
> ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
> npx electron-builder --config electron-builder.json --win
> ```

### 开发模式（源码）

```bash
cd desktop && npm start
```

需要仓库已有 `server/node_modules`、`web/node_modules` 和 `web/.next`（`npx next build`）。

### 用打包载荷测试（不生成安装包）

```bash
node desktop/scripts/build-runtime.mjs
node desktop/scripts/fetch-externals.mjs
node desktop/scripts/verify-externals.mjs   # 只留捆绑目录的 PATH，验证自足性
cd desktop && KADY_RUNTIME_DIR=./build/runtime npm start
```

## 架构

```
Kady.exe
  ├─ app.asar              壳代码（main.mjs / service-manager.mjs / preflight.mjs）
  └─ resources/
       ├─ runtime/          应用载荷
       │    ├─ server/src/**/*.mjs     后端（逐文件编译，保留目录结构）
       │    ├─ server/node_modules/    438 个生产依赖
       │    ├─ server/pi-packages/     Pi 扩展包
       │    ├─ server/src/helpers/     科学预览的 Python 解码器
       │    ├─ web/                    Next standalone 产物
       │    └─ models.json             模型价格目录
       └─ externals/        捆绑的二进制
            ├─ git/         PortableGit（已裁剪，含 bash.exe + git）
            └─ uv/          uv.exe
```

**运行时数据**（永不随安装包覆盖）：`%APPDATA%/Kady/data/`
- `.env` — 用户保存的 API key
- `projects/` — 项目文件与对话历史

## 关键实现决策

### 后端不打成单文件

`server/src` 中有 4 处 `import.meta.dirname` 相对路径（`../../pi-packages`、`../../node_modules`、`./subagent-host.mjs`、`../helpers`）。单文件 bundle 会破坏这些解析，所以逐文件编译 `.ts → .mjs` 并保留目录结构。

### `web/src/lib` 也要编译

后端有 11 个文件直接从 `web/src/lib/*.ts` import 共享逻辑（`chat-snapshot.ts`、`compaction-bridge.ts` 等），两者是编译时耦合的。构建脚本会解析这个闭包并一并编译到 `runtime/web/src/lib/`。

这些文件内部相互 import 时**不带扩展名**（Next 打包器能解析，Node ESM 不能），构建时会自动补 `.mjs`。

### `pi-packages` 同时保留 `.ts` 和 `.mjs`

- Pi 用自己的 TS 加载器读 `.ts`（`package.json` 的 `pi.extensions`）
- 后端直接用 Node import 时需要 `.mjs`

### 用 `ELECTRON_RUN_AS_NODE` 而非修改代码

后端有 3 处 `spawn(process.execPath, ...)`（MCP 客户端、技能下载）。在 Electron 中 `process.execPath` 是 `electron.exe`，直接 spawn 会启动新窗口而非执行脚本。

设 `ELECTRON_RUN_AS_NODE=1` 后 `electron.exe` 表现为纯 Node 运行时。已验证该变量会被孙进程继承（`piCliEnv`/`skillsCliEnv` 都是 `{...process.env}` 展开），所以**这 3 处无需任何代码改动**。

### bash 通过 Pi 的 `shellPath` 指定

Pi 的 `getShellConfig()` 解析顺序是：`settings.json` 的 `shellPath` → `Program Files\Git` → `PATH`。壳在启动时把捆绑的 bash 路径写进 `<agentDir>/settings.json`，优先级最高，不受用户机器上旧版 Git 影响。

若 `shellPath` 指向的路径已不存在（应用移动位置后），会被自动替换。

### PortableGit 而非 MinGit

**MinGit 不含 `bash.exe`**（只有 `git.exe` 和 `dash.exe`），而 bash 正是 agent 执行命令的核心。必须用 PortableGit。

PortableGit 2.56 完整解压 342 MB。裁剪掉 vim、mintty、man/doc、git-gui/gitk 后约 **299 MB**。

> **`ucrt64/` 和 `mingw64/` 必须保留**：那是 git 本体（`git.exe` 及其链接的 DLL）和 `libexec/git-core/`（`git clone` 等子命令的实现）。早期版本曾把整个 `mingw64/` 当成"GUI 工具链"删掉，结果 `git: command not found`，而且因为本机装了系统 Git 而看不出问题。`scripts/verify-externals.mjs` 用只含捆绑目录的 PATH 验证，专门堵这个洞。

PortableGit 2.56 把工具链从 `mingw64/` 移到了 `ucrt64/`；脚本按存在性探测两者，版本升级不会静默失效。

### 保持 `KADY_RUNTIME_DIR` escape hatch

虽然是整包更新，但载荷目录可被环境变量覆盖。出问题时可以手工替换载荷热修，不必重新发版。

## 外部依赖补齐

| 组件 | 来源 | 体积 |
|---|---|---|
| PortableGit 2.56.0.4（裁剪后） | GitHub / 清华镜像 | 299 MB |
| uv 0.12.13 | PyPI wheel（含 SHA-256 校验） | 40 MB |

两者都固定版本并记录来源。下载脚本优先走 GitHub，失败时自动回落镜像（本机实测 GitHub 直连超时）。

## 已验证

| 项 | 结果 |
|---|---|
| `next build` standalone | 成功，可独立运行 |
| 载荷独立启动 | `/health` 200、`/projects` 200 |
| Electron + 载荷（开发） | 窗口正常，UI 200 |
| **打包后 `Kady.exe`** | 窗口标题正常，`/health` 200，UI 200 |
| 捆绑 bash 执行命令 | `BUNDLED_BASH_OK`、`git 2.56`、`uv 0.12.13`，exit 0 |
| **隔离 PATH 验证** | 10 项全通过：bash / git / uv / 管道 / heredoc / git init / HTTPS clone，`git` 解析在捆绑目录内 |
| **打包版联网** | 在安装目录的 `externals/git` 上重跑隔离验证全过，`git ls-remote` 成功返回远端分支 |
| `shellPath` 写入 | 正确指向安装目录的 bash |
| 数据目录 | `%APPDATA%/Kady/data/` |
| `/tmp` 可用 | 临时文件读写正常 |
| 关闭清理 | 进程 0 残留，端口释放 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `KADY_RUNTIME_DIR` | 指定载荷目录（指向 `build/runtime`） |
| `KADY_DATA_ROOT` | 后端可写根目录（壳自动注入） |
| `KADY_MODELS_CATALOGUE` | 模型目录 JSON 路径 |
| `KADY_FRONTEND_PORT` | 后端信任的前端来源端口（CORS） |

## 尚未完成

- **代码签名**：`signExecutable: false`，Windows 会弹 SmartScreen 警告
- **自动更新**：上游 release 无二进制产物，需自建版本端点（参考 DSH Desktop 的做法）
- **首次启动的 Python 环境**：`uv sync` 会构建两个 venv（沙箱 + 预览 helper），耗时数分钟且需联网
- **技能库的网络依赖**：`skills` CLI 每次同步都重新 `git clone` 上游仓库（460 MB），网络不稳时会报 `SSL/TLS handshake` 或 `invalid index-pack output`。系统 Git 用同样命令也会失败，不是捆绑版的问题。已抓取过的缓存落在 `%TEMP%/kady-desk-skills/`，但 CLI 不复用它
- **macOS**：本分支提供原生打包与 uv，详见 [macOS 说明](MACOS.md)。
- **Linux**：配置未验证；依赖系统 bash、git 和 uv。

## 与 DSH Desktop 的对照

DSH Desktop（34k stars，同类产品）的更新做法值得参考：

- 不用 `electron-updater`，自研版本服务 + 固定下载端点
- NSIS 配 `differentialPackage: false`，**无增量更新**，每次全量下载 260–730 MB
- **无磁盘版本化目录、无 A/B 切换、无应用级回滚**
- 捆绑 Node + CPython + pnpm + 350 个固定版本 tarball

本项目的取舍与其一致：整包替换 + 自建版本服务，靠"确定性运行时闭包"换"确定的首次启动"。区别在于本项目保留了 `KADY_RUNTIME_DIR`，多一个热修通道。
