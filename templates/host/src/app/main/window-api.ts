import type { BrowserWindow } from "electron";
import { s } from "fluxplugin";
import type { MainFramework } from "fluxplugin/main";
import { CHANNELS, TITLEBAR_HEIGHT } from "../shared/constants";

/** Host operations that need the BrowserWindow. Add your own (maximize, always-on-top, …) the same way. */
export function registerWindowApi(fw: MainFramework, win: BrowserWindow): void {
  fw.manager.ipc.handle(
    CHANNELS.setTitleBarOverlay,
    (i: { color: string; symbolColor: string }) => {
      // Only Windows/Linux have the native-controls overlay; on macOS the traffic lights need no colouring.
      if (process.platform !== "darwin" && !win.isDestroyed()) {
        try {
          win.setTitleBarOverlay({ color: i.color, symbolColor: i.symbolColor, height: TITLEBAR_HEIGHT });
        } catch {
          /* colour not parseable: keep the previous one */
        }
      }
      return true;
    },
    "host",
    { input: s.object({ color: s.string(), symbolColor: s.string() }) },
  );
}
