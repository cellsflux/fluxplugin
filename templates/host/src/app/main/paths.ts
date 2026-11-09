import { existsSync } from "node:fs";
import path from "node:path";

/** Project root: set by `fluxplugin dev|start`; falls back to the folder above dist/ (packaged app). */
export function projectRoot(distDir: string): string {
  return process.env["FLUXPLUGIN_PROJECT"] ?? path.resolve(distDir, "..");
}

export interface PluginPaths {
  /** Plugins shipped with the app (read-only): <project>/plugins in dev, <resources>/plugins when packaged — or the ones inside a downloaded update. */
  bundled: string;
  /** Plugins installed by the user (writable): inside the app's data folder, removed with it when the app is uninstalled. */
  user: string;
}

export function pluginPaths(root: string, userData: string, packaged: boolean, resourcesPath: string, payloadDir?: string): PluginPaths {
  const fromUpdate = payloadDir && existsSync(path.join(payloadDir, "payload.json")) && existsSync(path.join(payloadDir, "plugins")) ? path.join(payloadDir, "plugins") : undefined;
  return { bundled: fromUpdate ?? (packaged ? path.join(resourcesPath, "plugins") : path.join(root, "plugins")), user: path.join(userData, "plugins") };
}
