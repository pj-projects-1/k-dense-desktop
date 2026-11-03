# Kady for macOS

This fork adds native macOS packaging to the Windows desktop wrapper. It retains the upstream Electron/Next.js/Pi architecture and MIT attribution.

## Install

Choose the `mac-arm64.dmg` for Apple Silicon or `mac-x64.dmg` for Intel. Open the disk image and drag Kady into Applications. macOS 12 or later is required by this build configuration. The initial local release is ad-hoc signed, not Apple-notarized; a downloaded copy may require approval under System Settings → Privacy & Security. Ad-hoc signing does not establish a verified publisher.

Git must already work on the Mac. If startup reports it missing, run `xcode-select --install` in Terminal, finish Apple's installation, then reopen Kady. Homebrew Git is also supported. The app uses system Bash, bundles a checksum-pinned native uv binary, and runs Node commands through Electron's embedded Node runtime. A separate Node or Python installation is not needed at runtime. Python 3.12 and scientific packages are downloaded on first use, so first-launch setup needs internet access and disk space.

Connect your chosen model in Settings → Providers. No credentials are included in the app. API billing and subscription availability are controlled by the provider.

## Data and background work

Projects and desktop settings: `~/Library/Application Support/Kady/data/`. Python helper environments and their writable project metadata live below `data/python/`, outside the signed application. Model authentication and global Pi settings retain upstream's `~/.kady/pi-agent/` location. Back up both locations; replacing the app does not replace these directories.

Closing a window keeps Kady running by default. Reopen from the Dock or menu bar. Use **Kady → Quit Kady** or Cmd+Q to stop it. Quitting aborts active local session tools; durable remote work retains upstream's recovery behavior.

The Mac desktop uses loopback ports **47821** (backend) and **47822** (frontend), avoiding the common port 8000 conflict. The normal web/source launcher and Windows desktop keep their upstream ports. A desktop frontend must be built using `build:web`, which embeds the correct backend URL.

## Build on a Mac

Use Node 24 and a working Git installation. Build on a Mac matching the target CPU; the packaging guard refuses cross-architecture mixtures of uv and native Node dependencies.

```sh
npm ci --prefix server --no-audit
npm ci --prefix web --no-audit
npm ci --prefix desktop --no-audit
cd desktop
npm run dist:mac
```

This builds the frontend, icons, runtime, pinned uv binary, and an ad-hoc signed `.app`, DMG and ZIP under `dist/`. It does not publish a release. `macos-desktop.yml` repeats this on separate Apple Silicon and Intel runners and uploads workflow artifacts.

For development, run `npm run build:web` before `npm start` in `desktop/`.

```sh
node desktop/scripts/fetch-externals.mjs
npm test --prefix desktop
npm run typecheck --prefix server
cd server && npx vitest run test/helpers-project.test.ts test/session-registry.test.ts
```

## Developer ID distribution

`npm run dist:mac:signed` uses normal electron-builder signing discovery and the production entitlements (JIT allowed, library validation retained). Provide your own Developer ID certificate and supported Apple notarization credentials through the CI secret store or your local signing environment. Never commit certificates, passwords or API keys. No signing identity or Apple account is configured in this fork.

The installed electron-builder version is 26: signing settings live directly under `mac`, unlike the newer v27 `mac.sign` layout. Local ad-hoc builds use a separate entitlement file because their Electron frameworks do not share a Developer ID Team ID. A signed distribution must be verified with `codesign --verify --deep --strict`, notarized and stapled, then tested as a downloaded application on a separate Mac.

## Validation scope

See the accompanying build report for the exact revision, artifacts, tests and limitations of a delivered build. Build configuration for Intel is not evidence of an Intel runtime test. Provider logins and paid model calls need the user's own credentials. The port does not add automatic updates or claim the upstream dependency tree is free of vulnerabilities.
