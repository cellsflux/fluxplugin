import { build } from "esbuild";
import { execSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
await import("./embed-templates.mjs");
rmSync("dist", { recursive: true, force: true });
const base = { bundle: true, format: "esm", splitting: true, sourcemap: false, logLevel: "warning", jsx: "automatic", chunkNames: "chunks/[name]-[hash]" };
const ext = ["react", "react-dom", "react/jsx-runtime", "electron", "esbuild"];
// Node side: isomorphic core + main + preload + CLI API share one core chunk (instanceof-safe).
await build({ ...base, platform: "node", target: "node20", outdir: "dist/node", external: ext,
  entryPoints: { index: "src/core/index.ts", main: "src/main/index.ts", preload: "src/preload/index.ts", "cli-api": "src/cli/index.ts" } });
// Renderer side: core + react runtime + manager UI share one core chunk (one React context, one registry).
await build({ ...base, platform: "browser", target: "chrome120", outdir: "dist/browser", external: ext,
  entryPoints: { index: "src/core/index.ts", react: "src/react/index.ts", "manager-ui": "src/manager-ui/index.tsx" } });
// Self-contained executable CLI (single file, no splitting).
await build({ ...base, splitting: false, platform: "node", target: "node20", entryPoints: ["src/cli/bin.ts"], outfile: "dist/cli.js", external: ["esbuild"],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
execSync("npx tsc -p tsconfig.build.json", { stdio: "inherit" });
console.log("fluxplugin built → dist/");
