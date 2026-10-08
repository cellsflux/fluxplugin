import { BrowserWindow, shell } from "electron";
import path from "node:path";
import { TITLEBAR_HEIGHT } from "../shared/constants";

/**
 * Frameless window with a custom title bar drawn by the renderer (<TitleBar />).
 *  - macOS: "hiddenInset" keeps the native traffic-light buttons (the bar reserves space for them).
 *  - Windows/Linux: "hidden" + titleBarOverlay keeps the native minimize/maximize/close buttons on the right.
 */
export function createMainWindow(distDir: string): BrowserWindow {
  const mac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 480,
    show: false,
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    ...(mac ? {} : { titleBarOverlay: { color: "#f8fafc", symbolColor: "#0f172a", height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(distDir, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  // The app never navigates away; https links open in the user's browser, everything else is blocked.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  void win.loadFile(path.join(distDir, "index.html"));
  return win;
}
