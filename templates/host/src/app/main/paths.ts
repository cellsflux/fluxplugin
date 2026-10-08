import path from "node:path";

/** Project root: set by `fluxplugin dev|start`; falls back to the folder above dist/ (packaged app). */
export function projectRoot(distDir: string): string {
  return process.env["FLUXPLUGIN_PROJECT"] ?? path.resolve(distDir, "..");
}

/** Plugins bundled with the app (read-only) and plugins installed by the user (writable). */
export function pluginDirs(root: string, userData: string): string[] {
  return [path.join(root, "plugins"), path.join(userData, "plugins")];
}
