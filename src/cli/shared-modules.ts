import path from "node:path";
import type { Plugin } from "esbuild";

/** Modules provided by the host at runtime through `globalThis.__FLUXPLUGIN_SHARED__` (single instance of React, the runtime...). */
export const SHARED_MODULES = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "fluxplugin", "fluxplugin/react", "fluxplugin/manager-ui"];

/**
 * esbuild plugin rewriting imports of shared modules to `globalThis.__FLUXPLUGIN_SHARED__[id]`.
 * Without it each plugin bundle would ship its own React and hooks would break (two React copies).
 */
export function sharedModulesPlugin(shared: string[] = SHARED_MODULES): Plugin {
  const set = new Set(shared);
  return {
    name: "flux-shared-modules",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (set.has(args.path)) return { path: args.path, namespace: "flux-shared" };
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "flux-shared" }, (args) => ({
        contents: `const m = globalThis.__FLUXPLUGIN_SHARED__ && globalThis.__FLUXPLUGIN_SHARED__[${JSON.stringify(args.path)}];
if (!m) throw new Error("Shared module ${args.path} is not provided by the host application (see installSharedModules).");
module.exports = m;`,
        loader: "js",
        resolveDir: path.resolve("."),
      }));
    },
  };
}
