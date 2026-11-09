import type { MainFramework } from "./framework.js";

export interface WindowLike {
  on(event: "close", listener: (e: { preventDefault(): void }) => void): unknown;
  close(): void;
  hide(): void;
  isDestroyed(): boolean;
}

/**
 * Closing the window asks the UI first (QuitGuard in the renderer): unsaved edits and running actions are listed, and an update that is
 * downloading can continue in the background. If the page does not answer (crashed), the window closes anyway.
 */
export function guardWindowClose(win: WindowLike, fw: MainFramework, app: { quit(): void }, timeoutMs = 2500): void {
  let closing = false;
  let asked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ipc = fw.manager.ipc;
  ipc.handle("flux.app.closeAck", () => (clearTimeout(timer), true), "host", {});
  ipc.handle("flux.app.confirmClose", ((i: { ok: boolean; background?: boolean }) => {
    clearTimeout(timer);
    asked = false;
    if (!i?.ok) return false;
    closing = true;
    if (i.background && fw.updater) {
      win.hide(); // keep downloading; quit when the download ends (the new version loads at the next start)
      fw.updater.onceIdle(() => app.quit());
    } else if (!win.isDestroyed()) win.close();
    return true;
  }) as never, "host", {});
  win.on("close", (e) => {
    if (closing) return;
    e.preventDefault();
    if (asked) return;
    asked = true;
    fw.broadcast("flux.app.closeRequested", {});
    timer = setTimeout(() => ((closing = true), !win.isDestroyed() && win.close()), timeoutMs);
  });
}
