import { HOST_APP_FILES, HOST_TAILWIND_FILES } from "./host-files.generated.js";
import { TEMPLATES, varsFromName } from "./templates.js";

export interface HostVars {
  name: string;
  fluxSpec: string;
  /** Electron semver range (init resolves the latest published version). */
  electron?: string;
  tailwind?: boolean;
}

/** Files of a new host application (`fluxplugin init`). Plain strings so the CLI stays a single self-contained file. */
export function hostFiles(v: HostVars, withSample = true): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: v.name,
        version: "0.1.0",
        private: true,
        type: "module",
        main: "dist/main.cjs",
        scripts: {
          dev: "fluxplugin dev",
          "dev:web": "fluxplugin dev --web",
          build: "fluxplugin build",
          start: "fluxplugin start",
          "plugin:new": "fluxplugin plugin new",
          typecheck: "tsc --noEmit",
        },
        dependencies: { fluxplugin: v.fluxSpec, react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { electron: v.electron ?? "^44.5.1", typescript: "~5.9.3", "@types/node": "^22.10.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", ...(v.tailwind ? { tailwindcss: "^4.0.0", "@tailwindcss/cli": "^4.0.0" } : {}) },
        // npm 11.16+/12 and pnpm 10 block dependency install scripts unless allowed; Electron needs its postinstall to download the binary.
        allowScripts: { electron: true, esbuild: true },
        pnpm: { onlyBuiltDependencies: ["electron", "esbuild"] },
      },
      null,
      2,
    ),
    // "stores" is used by the CLI (fluxplugin search/install) AND by your app (Plugins → Available). Add your own store here.
    "fluxplugin.config.json": JSON.stringify({ pluginsDir: "plugins", outDir: "dist", stores: [{ type: "github", topic: "fluxplugin-plugin" }] }, null, 2),
    "tsconfig.json": JSON.stringify(
      { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: true, resolveJsonModule: true, lib: ["ES2022", "DOM", "DOM.Iterable"], types: ["node"] }, include: ["src"] },
      null,
      2,
    ),
    ".gitignore": "node_modules\ndist\n.flux-data\n*.tgz\n",
    "README.md": readme(v.name),
  };
  // The application itself: layered under src/app (shared → main / preload / renderer).
  for (const [rel, content] of Object.entries(HOST_APP_FILES)) files[rel] = content.split("__APP_NAME__").join(v.name);
  if (v.tailwind) for (const [rel, content] of Object.entries(HOST_TAILWIND_FILES)) files[rel] = content.split("__APP_NAME__").join(v.name);
  if (withSample) {
    const sample = TEMPLATES.dashboard(varsFromName("hello"));
    for (const [rel, content] of Object.entries(sample)) {
      if (rel === "package.json" || rel === "tsconfig.json") continue;
      files[`plugins/hello/${rel}`] = content;
    }
  }
  return files;
}

const readme = (name: string): string => `# ${name}

Created with [fluxplugin](https://www.npmjs.com/package/fluxplugin).

\`\`\`bash
npm install
npm run dev:web      # in a browser, no Electron needed
npm run dev          # in Electron (plugins hot-reload)
npm run build && npm start
npm run plugin:new my-plugin -- -t backend    # scaffold a plugin in ./plugins
\`\`\`

## Structure (everything lives in src/app)

\`\`\`
src/app/
  shared/      constants.ts, types.ts     names used by both processes (depends on nothing)
  main/        index.ts (Electron entry) · web.ts (browser entry) · framework.ts · operations.ts · window.ts · paths.ts
  preload/     index.ts                    exposes window.__fluxplugin
  renderer/
    index.tsx · index.html                 entry
    bootstrap.ts                           bridge, shared modules, framework start   (infrastructure)
    extension-points.ts · routes.ts        what plugins may extend / host pages
    providers/  shell/  pages/             UI layers
    hooks/  services/                      app logic (services know the IPC channels, hooks serve the UI)
    styles/app.css
plugins/       plugins loaded at startup (users can also install .tgz from the Plugins page)
\`\`\`
`;
