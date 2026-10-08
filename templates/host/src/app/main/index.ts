// Electron entry (main process). Keep it thin: wiring only, logic lives in the other files of this folder.
import { app, ipcMain, Menu, protocol, webContents } from "electron";
import path from "node:path";
import { PLUGIN_SCHEME, attachElectron, registerPluginProtocol } from "fluxplugin/main";
import { APP_NAME } from "../shared/constants";
import { createFramework } from "./framework";
import { pluginDirs, projectRoot } from "./paths";
import { createMainWindow } from "./window";
import { registerWindowApi } from "./window-api";

// Own data folder per app. In dev Electron is started as `electron dist/main.cjs` and would otherwise be called "Electron",
// sharing plugin state (enabled/disabled, permissions, settings) with every other app run that way.
app.setName(APP_NAME);

protocol.registerSchemesAsPrivileged([PLUGIN_SCHEME]); // must run before the app is ready

app.whenReady().then(async () => {
  const dev = !!process.env["FLUXPLUGIN_DEV"];
  // The menu bar is drawn by the renderer (<TitleBar />). Windows/Linux: no native menu. macOS keeps a minimal one
  // so the system shortcuts (copy/paste/quit/hide) keep working.
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);

  const fw = createFramework({
    pluginDirs: pluginDirs(projectRoot(__dirname), app.getPath("userData")),
    dataDir: path.join(app.getPath("userData"), "plugins-data"),
    dev,
  });
  registerPluginProtocol(fw, protocol);
  attachElectron(fw, { ipcMain: ipcMain as never, webContents: webContents as never });
  await fw.start();

  const win = createMainWindow(__dirname);
  registerWindowApi(fw, win);
  if (dev) win.webContents.on("before-input-event", (_e, input) => input.key === "F12" && input.type === "keyDown" && win.webContents.toggleDevTools());
  app.on("before-quit", () => void fw.stop());
});

app.on("window-all-closed", () => app.quit());
