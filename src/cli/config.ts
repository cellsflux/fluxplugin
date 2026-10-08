import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_STORE, type StoreSpec } from "../main/index.js";

export interface CliConfig {
  pluginsDir: string;
  dataDir: string;
  /** Plugin stores used by `search` / `install <id>` (same list your app uses). Default: the GitHub topic store. */
  stores: StoreSpec[];
}

/** Resolves `--dir/--data` flags, then `fluxplugin.config.json` in the cwd, then defaults. */
export async function loadConfig(flags: { dir?: string; data?: string }, cwd = process.cwd()): Promise<CliConfig> {
  let file: Partial<CliConfig> = {};
  try {
    file = JSON.parse(await fs.readFile(path.join(cwd, "fluxplugin.config.json"), "utf8"));
  } catch {
    /* optional */
  }
  return {
    pluginsDir: path.resolve(cwd, flags.dir ?? file.pluginsDir ?? "plugins"),
    dataDir: path.resolve(cwd, flags.data ?? file.dataDir ?? ".flux-data"),
    stores: Array.isArray(file.stores) && file.stores.length ? file.stores : [DEFAULT_STORE],
  };
}
