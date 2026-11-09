// Electron entry (main process). Keep it thin: wiring only, logic lives in the other files of this folder.
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Notification, protocol, session, shell, Tray, webContents } from "electron";
import path from "node:path";
import { PLUGIN_SCHEME, attachElectron, attachFileOpen, confirmBoot, createElectronBackend, guardWindowClose, payloadVersion, registerPluginProtocol, type UpdateSource } from "fluxplugin/main";
import config from "../../../fluxplugin.config.json";
import { APP_NAME } from "../shared/constants";
import { createFramework } from "./framework";
import { pluginPaths, projectRoot } from "./paths";
import { createMainWindow } from "./window";
import { registerWindowApi } from "./window-api";

// Own data folder per app (in dev Electron would otherwise be called "Electron" and share plugin state with every other app).
app.setName(APP_NAME);
protocol.registerSchemesAsPrivileged([PLUGIN_SCHEME]); // must run before the app is ready

app.whenReady().then(async () => {
  const dev = !!process.env["FLUXPLUGIN_DEV"];
  // The menu bar is drawn by the renderer (<TitleBar />). macOS keeps a minimal one so the system shortcuts keep working.
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);

  const paths = pluginPaths(projectRoot(__dirname), app.getPath("userData"), app.isPackaged, process.resourcesPath, __dirname);
  const updatesDir = path.join(app.getPath("userData"), "app-updates");
  const upd = (config as { updates?: { enabled?: boolean; source: unknown; intervalHours?: number; autoDownload?: boolean; publicKey?: string } }).updates;
  const fw = createFramework({
    pluginDirs: [paths.bundled, paths.user],
    installDir: paths.user,
    dataDir: path.join(app.getPath("userData"), "plugins-data"),
    dev,
    // FluxAPI: notifications, file dialogs/read/write, clipboard, links, app info (permission-checked per plugin)
    desktop: { backend: createElectronBackend({ dialog, Notification, clipboard, shell, app, globalShortcut, Tray, Menu, BrowserWindow } as never) }, // add { trayIcon: "path/to/icon.png" } as 2nd argument to enable the tray
    // Progressive application updates (set "updates.enabled" in fluxplugin.config.json)
    updates: upd?.enabled && !dev
      ? { source: upd.source as UpdateSource, dir: updatesDir, currentVersion: payloadVersion(__dirname, app.getVersion()), payloadDir: __dirname, hostVersion: app.getVersion(), publicKey: upd.publicKey, checkOnStart: true, intervalHours: upd.intervalHours ?? 6, autoDownload: upd.autoDownload, restart: () => (app.relaunch(), app.exit(0)) }
      : undefined,
  });
  registerPluginProtocol(fw, protocol);
  attachElectron(fw, { ipcMain: ipcMain as never, webContents: webContents as never });
  attachFileOpen(fw, app as never); // double-click / "Open with…" / drop on the icon → the plugins' file handlers
  // Camera: the page may use it (plugins still need the "camera" permission, checked by useCamera).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  await fw.start();

  const win = createMainWindow(__dirname);
  registerWindowApi(fw, win);
  guardWindowClose(win as never, fw, app); // asks before closing with unsaved work or a running download
  win.once("ready-to-show", () => confirmBoot(updatesDir)); // the new version started: keep it
  if (dev) win.webContents.on("before-input-event", (_e, input) => input.key === "F12" && input.type === "keyDown" && win.webContents.toggleDevTools());
  app.on("before-quit", () => void fw.stop());
});

app.on("window-all-closed", () => app.quit());
