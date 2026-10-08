import type { FluxBridge } from "fluxplugin";
import { CHANNELS } from "../../shared/constants";

/** Colours the native window buttons (Windows/Linux). A no-op error in browser mode is ignored on purpose. */
export function setTitleBarOverlay(bridge: FluxBridge, color: string, symbolColor: string): void {
  void bridge.invoke(CHANNELS.setTitleBarOverlay, { color, symbolColor }).catch(() => undefined);
}
