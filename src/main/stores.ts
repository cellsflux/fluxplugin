import path from "node:path";
import { DEFAULT_TOPIC, GitHubRegistry } from "./github-registry.js";
import { HttpRegistry, LocalRegistry, type PluginRegistry } from "./registry.js";

/**
 * A plugin store, as written in `fluxplugin.config.json` → `"stores"` (or passed to `MainFramework`).
 *  - `github` + `topic`: every repo with that topic that published a release with `fluxplugin publish` (default store)
 *  - `github` + `repo`:  a curated catalog repository ("owner/name") containing `index.json`
 *  - `http`:             a static host serving `index.json` + packages/folders (GitHub Pages, S3, your server)
 *  - `json`:             one URL that returns the catalog as JSON (a file, or your own API); same format as index.json
 *  - `local`:            a folder (network share, checkout)
 */
export type StoreSpec =
  | { type: "github"; topic?: string; repo?: string; ref?: string; indexPath?: string; name?: string }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "json"; url: string; headers?: Record<string, string> }
  | { type: "local"; path: string };

export const DEFAULT_STORE: StoreSpec = { type: "github", topic: DEFAULT_TOPIC };

/** Builds registries from store specs. The GitHub token (if any) comes from GITHUB_TOKEN / GH_TOKEN, never from config files. */
export function createRegistries(specs: StoreSpec[] = [DEFAULT_STORE], opts: { env?: Record<string, string | undefined>; baseDir?: string; fetchImpl?: typeof fetch } = {}): PluginRegistry[] {
  const env = opts.env ?? process.env;
  const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
  return specs.map((s) => {
    switch (s.type) {
      case "github":
        return new GitHubRegistry({ ...s, token, fetchImpl: opts.fetchImpl });
      case "http":
      case "json":
        return new HttpRegistry(s.url, opts.fetchImpl, s.headers, s.type === "json");
      case "local":
        return new LocalRegistry(path.resolve(opts.baseDir ?? process.cwd(), s.path));
      default:
        throw new Error(`unknown store type: ${JSON.stringify(s)}`);
    }
  });
}
