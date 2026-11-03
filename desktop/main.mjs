/**
 * Stage-0 desktop shell for K-Dense BYOK.
 *
 * Reuses the existing launch contract instead of reimplementing it: the
 * backend runs through tsx and the frontend through `next start`, both bound
 * to the ports the current web build was compiled against (3000/8000).
 *
 * The window points at the local frontend origin. Everything else — SSE
 * streaming, file previews, the Office iframe — keeps working because the
 * renderer is a real Chromium page talking to the same origins the browser
 * build expects.
 */
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { BACKEND_URL, UI_URL, packagedArtifacts, setFatalHandler, startServices, stopServices } from "./service-manager.mjs";
import { checkRuntime } from "./preflight.mjs";
import { runtimeEnvironment } from "./runtime-env.mjs";

const isDev = !app.isPackaged;

// Electron derives app.getPath("userData") from the package name, which is
// "kady-desktop" while the product is "Kady". Pin the name so a packaged app
// and a checkout agree on where user data lives.
app.setName("Kady");
if (process.env.KADY_DESKTOP_USER_DATA) {
  const userData = path.resolve(process.env.KADY_DESKTOP_USER_DATA);
  fs.mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
}

/** Keep one window; re-focusing the dock/taskbar icon should not spawn more. */
let mainWindow = null;
let tray = null;
let quitting = false;
/** Set once startServices() has been called; services outlive any one window. */
let servicesStarted = false;

/**
 * Writable state lives outside the install directory: a packaged app under
 * Program Files cannot write its own `.env`, and projects must survive an
 * upgrade. Electron gives us the right per-user location per platform.
 */
function dataRoot() {
  return process.env.KADY_DATA_ROOT ? path.resolve(process.env.KADY_DATA_ROOT) : path.join(app.getPath("userData"), "data");
}

/**
 * Shell preferences, kept beside the backend's own settings rather than in
 * Electron's userData root so `%APPDATA%/Kady/data` stays the one directory a
 * user has to back up.
 */
function shellSettingsPath() {
  return path.join(dataRoot(), "shell.json");
}

function readShellSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(shellSettingsPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * What closing the window does.
 *
 * `tray` destroys the window and keeps the process alive, which drops a
 * ~750 MB resident app to roughly 300 MB (the renderer is 274 MB of that). It
 * is the default because background work — Modal jobs, schedules — should not
 * stop just because the window was dismissed. `quit` is the classic behaviour
 * and stays available for users who dislike a resident process.
 *
 * The file is also served over /settings/shell (server/src/shell-settings.ts),
 * which is how the Settings UI writes it. Keep the two readers agreeing on the
 * field name and the "tray" default.
 */
function closeAction() {
  const value = readShellSettings().closeAction;
  return value === "quit" ? "quit" : "tray";
}

/** Whether a finished turn should raise a desktop notification. */
function notifySettings() {
  const s = readShellSettings();
  return {
    enabled: s.notifyOnRunComplete === true,
    // Default on: a notification for the chat already on screen is noise.
    onlyWhenUnfocused: s.notifyOnlyWhenUnfocused !== false,
  };
}

/**
 * Watch for turns finishing and tell the user when the app is in the
 * background.
 *
 * The backend already reports which sessions have a run in flight
 * (`/runtime-status`), so completion is the transition from "something
 * running" to "nothing running" — no backend change, and it covers runs this
 * window did not start (scheduled runs, runs in another tab).
 *
 * Polled rather than pushed: there is no renderer-side notification bridge
 * here on purpose (the page is an unmodified sandboxed web app), and this is a
 * 5-second check against a local server, not a network call.
 */
function startRunWatcher() {
  let previous = null;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(`${BACKEND_URL}/runtime-status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return;
      const body = await res.json();
      const running = Array.isArray(body?.sessions) ? body.sessions : [];
      const count = typeof body?.runningSessions === "number" ? body.runningSessions : running.length;

      if (previous !== null && previous > 0 && count === 0) {
        const { enabled, onlyWhenUnfocused } = notifySettings();
        const focused = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
        if (enabled && (!onlyWhenUnfocused || !focused)) {
          raiseRunCompleteNotification(previous);
        }
      }
      previous = count;
    } catch {
      // The backend may still be starting or momentarily busy; the next tick
      // retries. Resetting `previous` would make the next completion look like
      // the first observation and get skipped.
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), 5000);
  timer.unref?.();
  return timer;
}

/** One notification per completion, collapsing a burst into a count. */
function raiseRunCompleteNotification(finishedCount) {
  if (!Notification.isSupported()) return;
  // Clicking the balloon should land in the app, not dismiss and do nothing.
  const notification = new Notification({
    title: finishedCount > 1 ? `${finishedCount} chats finished` : "Chat finished",
    body:
      finishedCount > 1
        ? "Your runs are done — open Kady to read the replies."
        : "Your reply is ready — open Kady to read it.",
    silent: false,
  });
  notification.on("click", () => void reopenWindow());
  notification.show();
}

function writeShellSetting(key, value) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(shellSettingsPath(), "utf8"));
    if (!current || typeof current !== "object") current = {};
  } catch {
    current = {};
  }
  current[key] = value;
  fs.mkdirSync(path.dirname(shellSettingsPath()), { recursive: true });
  fs.writeFileSync(shellSettingsPath(), `${JSON.stringify(current, null, 2)}\n`);
}

/**
 * Where prebuilt artifacts live. A packaged app keeps them under resources/;
 * KADY_RUNTIME_DIR points a checkout at `desktop/build/runtime` for testing
 * the packaged path without building an installer.
 */
function runtimeArtifacts() {
  if (process.env.KADY_RUNTIME_DIR) {
    // KADY_RUNTIME_DIR names the payload itself (…/build/runtime), while
    // packagedArtifacts expects the parent that contains runtime/ and
    // externals/ side by side.
    const dir = path.resolve(process.env.KADY_RUNTIME_DIR);
    const parent = path.dirname(dir);
    const artifacts = packagedArtifacts(parent);
    if (!artifacts) return {};
    const externals = path.join(parent, "externals");
    return fs.existsSync(externals) ? { ...artifacts, externalsDir: externals } : artifacts;
  }
  return packagedArtifacts(process.resourcesPath) ?? {};
}

/**
 * The application menu.
 *
 * The window is a web app: every feature lives in the page, so the default
 * menu's File/Edit/View items are mostly noise. It still has to exist, though,
 * because Chromium routes its editing accelerators (Ctrl+C/V/X/Z/A) and zoom
 * through menu roles — with no menu at all, Ctrl+V stops working in every text
 * field, which this app is full of.
 *
 * So: a complete role-based menu, hidden from the window. Shortcuts keep
 * working; the menu bar does not take a strip off the top of the app. Alt
 * reveals it, the platform convention on Windows and Linux.
 */
function buildApplicationMenu() {
  const quitItem = { label: "Quit Kady", accelerator: "CmdOrCtrl+Q", click: () => void quitApp() };
  const template = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [{ role: "about" }, { type: "separator" }, { role: "services" },
        { type: "separator" }, { role: "hide" }, { role: "hideOthers" },
        { role: "unhide" }, { type: "separator" }, quitItem],
    }] : [{ label: "File", submenu: [quitItem] }]),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0b0c",
    show: false,
    title: "K-Dense BYOK",
    // Hidden, not absent: see buildApplicationMenu. `autoHideMenuBar` also lets
    // Alt reveal it for anyone who wants the reload or devtools entries.
    autoHideMenuBar: true,
    // A packaged build reads the exe's own icon; this is what the taskbar and
    // window switch to during development, when there is no exe icon to embed.
    ...(isDev ? { icon: path.join(import.meta.dirname, "resources", "icon.png") } : {}),
    webPreferences: {
      // The renderer is the unmodified web app: no preload bridge, no Node
      // integration, so it keeps the exact security posture it has in a
      // browser tab.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Chat content, citations and notebook links open in the user's browser.
  // Everything pointing back at the local UI stays inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  return mainWindow;
}

/** Same-origin as the local UI, including the app-opened popups it relies on. */
function isInternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Drive the startup placeholder's two lines while the services come up.
 *
 * The renderer is a `data:` document, so it cannot fetch the loopback API
 * itself (cross-origin, and the backend's request guard rejects the null
 * origin). Polling here and injecting text over `executeJavaScript` keeps the
 * placeholder a plain page with no preload bridge.
 *
 * Stops on its own once the window navigates to the real UI.
 */
function startStatusPolling(window) {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  window.webContents.once("did-start-navigation", (event) => {
    // The placeholder is the first document; anything after it is the app.
    if (!event.isSameDocument) stop();
  });
  window.webContents.once("destroyed", stop);

  const say = (text, hint) => {
    if (stopped || window.isDestroyed()) return;
    window.webContents
      .executeJavaScript(
        `(() => {
           const line = document.getElementById("line");
           const note = document.getElementById("hint");
           if (!line) return false;
           line.textContent = ${JSON.stringify(text)};
           if (note) note.textContent = ${JSON.stringify(hint ?? "")};
           return true;
         })()`,
      )
      .catch(() => {});
  };

  const tick = async () => {
    if (stopped || window.isDestroyed()) return;
    try {
      const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const helpers = body?.setup?.helpers;
      if (helpers?.state === "syncing") {
        say(
          "Preparing Python previews…",
          "Installing scientific Python packages. This happens once, and can take several minutes.",
        );
      } else if (helpers?.state === "failed") {
        say(
          "Starting local services…",
          `Python previews are unavailable (${helpers.detail ?? "uv sync failed"}). The app still works.`,
        );
      } else {
        say("Starting local services…", "Loading the interface…");
      }
    } catch {
      // Backend not listening yet: the placeholder already says so.
    }
    if (!stopped) setTimeout(tick, 1500);
  };
  void tick();

  // The frontend usually answers a moment after the backend; without a hint
  // the gap looks like a stall.
  setTimeout(() => {
    say("Starting the interface…", "The first launch takes longer than later ones.");
  }, 20_000);
}

/** The "Starting…" document, kept out of boot() so reopening can reuse it. */
const SPLASH_HTML =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<!doctype html><meta charset="utf-8">
     <body style="margin:0;height:100vh;display:grid;place-items:center;
                  background:#0b0b0c;color:#a1a1aa;
                  font:14px/1.6 system-ui,sans-serif">
       <div style="text-align:center;max-width:32rem;padding:0 2rem">
         <div style="font-size:16px;color:#e4e4e7;margin-bottom:12px">K-Dense BYOK</div>
         <div id="line">Starting local services…</div>
         <div id="hint" style="margin-top:10px;font-size:12px;color:#52525b"></div>
       </div>
     </body>`,
  );

/**
 * Start the two services once per process. Later windows attach to them; this
 * is what makes closing the window cheap enough to be the default.
 */
async function bootServices() {
  const artifacts = runtimeArtifacts();

  // Fail on a missing shell before any window opens: without one, every agent
  // tool call fails with an error the user cannot act on.
  Object.assign(process.env, runtimeEnvironment(artifacts));
  const { blocking, warnings } = checkRuntime(artifacts);
  if (blocking.length) {
    await dialog.showMessageBox({
      type: "error",
      title: "K-Dense BYOK cannot start",
      message: "A required component is missing.",
      detail: blocking.join("\n\n"),
    });
    await quitApp({ force: true });
    return { ok: false, detail: blocking.join("\n\n") };
  }
  if (warnings.length) {
    console.warn(warnings.join("\n"));
  }

  servicesStarted = true;
  const result = await startServices({ dataRoot: dataRoot(), ...artifacts });
  return result;
}

/** Open the window. When the services are still coming up this shows the
 *  progress splash; a window opened later goes straight to the app because the
 *  backend is already answering.
 */
async function openWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return mainWindow;
  }
  const window = createWindow();

  const backendReady = servicesStarted && (await backendAnswers());
  if (backendReady) {
    await window.loadURL(UI_URL);
  } else {
    await window.loadURL(SPLASH_HTML);
    startStatusPolling(window);
  }

  if (isDev) window.webContents.openDevTools({ mode: "detach" });
  return window;
}

/** Cheap reachability probe, used to skip the splash on a warm reopen. */
async function backendAnswers() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function boot() {
  const result = await bootServices();
  if (quitting) return;
  if (!result?.ok) {
    await dialog.showMessageBox({
      type: "error",
      title: "K-Dense BYOK could not start",
      message: "The local services did not become ready.",
      detail:
        result?.detail ??
        (isDev
          ? "Check the terminal output for the failing service. If dependencies are missing, " +
            "run `npm install` in server/ and web/, then try again."
          : `Check that no other program is using ${UI_URL} or ${BACKEND_URL}, then restart the app.`),
    });
    app.quit();
    return;
  }

  await openWindow();
}

// A single instance owns the ports; a second launch focuses the first window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Launching the app again is a request to see it, whether the window is
    // minimized or was closed to the tray.
    void reopenWindow();
  });

  setFatalHandler(() => {
    if (quitting) return;
    void dialog
      .showMessageBox({
        type: "error",
        title: "A Kady service stopped",
        message: "The app has to close because one of its local services exited.",
        detail: "Restart K-Dense BYOK to try again. The terminal output has the details.",
      })
      .then(() => app.quit());
  });

  app.whenReady().then(async () => {
    // Install the menu before the first window: roles are what give Chromium
    // its Ctrl+C/V and zoom accelerators.
    buildApplicationMenu();
    // The tray exists from the start so a window close lands in a running
    // shell rather than orphaning the process with no way back.
    if (closeAction() === "tray") createTray();
    await boot();
    // Started after boot: before that there is no backend to ask, and the
    // first observation would be a false "nothing running".
    startRunWatcher();
  }).catch((error) => {
    console.error("boot failed:", error);
    app.quit();
  });

  // Closing the window is handled in `window-all-closed`: in tray mode the app
  // keeps running, otherwise it quits (after asking about streaming runs).
  app.on("window-all-closed", () => {
    // The window is already gone by now; this decides whether the process
    // follows it. In tray mode the renderer (~274 MB) is reclaimed but the
    // backend keeps running, so schedules and Modal jobs do not stop.
    if (closeAction() === "quit") {
      void quitApp();
      return;
    }
    ensureTrayHint();
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void quitApp();
  });

  // macOS: the dock icon brings the window back instead of quitting.
  app.on("activate", () => {
    if (quitting) return;
    void reopenWindow();
  });
}

/**
 * Ask the backend what a quit would interrupt.
 *
 * Only a running turn (streaming, or a run in its model-setup phase) counts.
 * Durable Modal jobs are explicitly restart-recoverable, and a queued async
 * subagent run reattaches on the next launch, so warning about those would
 * teach users to dismiss the dialog without reading it.
 */
async function quitInterruptsWork() {
  try {
    const res = await fetch(`${BACKEND_URL}/runtime-status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.runningSessions === "number" ? body : null;
  } catch {
    // No backend (already stopping, or it never started): nothing to warn about.
    return null;
  }
}

/**
 * Tray icon and menu. Right-click gives the two actions that matter: get the
 * window back, or actually stop the app. Double-click is the platform habit on
 * Windows and costs nothing to support.
 */
function createTray() {
  if (tray) return tray;
  // Packaged: extraResources puts the png beside runtime/ in resources/.
  // Checkout: read it straight from the desktop folder.
  const candidates = isDev
    ? [path.join(import.meta.dirname, "resources", "icon.png")]
    : [path.join(process.resourcesPath, "icon.png"), path.join(process.resourcesPath, "icon.ico")];
  let image = nativeImage.createEmpty();
  for (const candidate of candidates) {
    image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) break;
  }
  if (image.isEmpty()) {
    // An invisible tray icon would leave the app running with no way back;
    // better to say so than to hide the problem.
    console.warn(`[tray] no icon found in ${candidates.join(", ")}`);
  }

  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip("K-Dense BYOK");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open K-Dense BYOK", click: () => void reopenWindow() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => void quitApp({ force: true }),
      },
    ]),
  );
  tray.on("double-click", () => void reopenWindow());
  return tray;
}

/** Bring the window back, recreating it if the user closed it. */
async function reopenWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  try {
    await openWindow();
  } catch (error) {
    console.error("could not reopen the window:", error);
  }
}

/**
 * The one exit path: ask about streaming runs, stop the services, quit.
 *
 * Services must be stopped before `app.quit()` — `before-quit` also runs on
 * paths that never started them (a second instance rejecting the lock), and
 * `stopServices` is idempotent, so calling it twice is harmless.
 *
 * `force` skips the active-run prompt; the tray's Quit item is an explicit
 * instruction and should not bounce back with a dialog.
 */
async function quitApp({ force = false } = {}) {
  if (quitting) return;
  if (!force && !(await confirmQuitWithActiveRuns())) return;
  quitting = true;
  await stopServices();
  app.quit();
}

/**
 * Tell the user the app is still running the first time they close it, or
 * they conclude the close failed and try again. Windows balloons are the
 * platform's own idiom and need no notification permission.
 */
function ensureTrayHint() {
  const s = readShellSettings();
  if (s.trayHintShown) return;
  const t = createTray();
  if (process.platform === "win32" && t && typeof t.displayBalloon === "function") {
    t.displayBalloon({
      title: "K-Dense BYOK is still running",
      content: "Right-click the tray icon to reopen the window or quit.",
    });
  }
  writeShellSetting("trayHintShown", true);
}

/** True when the app should quit; false keeps it running. */
async function confirmQuitWithActiveRuns() {
  const status = await quitInterruptsWork();
  if (!status || status.runningSessions === 0) return true;

  const names = status.sessions
    .map((s) => s.name)
    .filter(Boolean)
    .slice(0, 5);
  const detail =
    names.length > 0
      ? `Still running: ${names.join(", ")}. Closing now ends the response mid-stream.`
      : "A response is still streaming. Closing now ends it mid-stream.";

  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "A response is still running",
    message:
      status.runningSessions === 1
        ? "One chat is still working."
        : `${status.runningSessions} chats are still working.`,
    detail,
    buttons: ["Keep working", "Quit anyway"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}
