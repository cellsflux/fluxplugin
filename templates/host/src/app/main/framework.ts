import { MainFramework, type StoreSpec } from "fluxplugin/main";
import config from "../../../fluxplugin.config.json"; // bundled into the app at build time
import { CHANNELS } from "../shared/constants";
import { registerOperations } from "./operations";

export interface FrameworkOptions {
  pluginDirs: string[];
  dataDir: string;
  dev?: boolean;
  assetUrl?: (id: string, rel: string) => string;
}

/** Creates the plugin framework. Shared by the Electron entry (index.ts) and the browser entry (web.ts). */
export function createFramework(opts: FrameworkOptions): MainFramework {
  const fw = new MainFramework({
    pluginDirs: opts.pluginDirs,
    dataDir: opts.dataDir,
    hotReload: opts.dev,
    assetUrl: opts.assetUrl,
    // Where "Plugins → Available" looks. Default: GitHub (every repo that published with `fluxplugin publish`).
    // Edit "stores" in fluxplugin.config.json to add your own store (github catalog, http, local) — see docs/STORE.md.
    stores: config.stores as StoreSpec[],
    requireApproval: false, // true → users must approve each plugin's permissions
    allowedRendererChannels: [CHANNELS.createItem, CHANNELS.setTitleBarOverlay],
  });
  registerOperations(fw);
  return fw;
}
