import { promises as fs } from "node:fs";
import path from "node:path";
import { build, context, type BuildOptions } from "esbuild";
import { validateManifest } from "../core/index.js";
import { sharedModulesPlugin } from "./shared-modules.js";
import { compileTailwind } from "./tailwind.js";

const exists = (f: string) => fs.access(f).then(() => true, () => false);
async function firstExisting(root: string, names: string[]): Promise<string | undefined> {
  for (const n of names) if (await exists(path.join(root, n))) return path.join(root, n);
}

/** Convention: dist/X is built from src/X (main.ts, renderer.tsx, styles/*.css). */
export async function buildOptions(root: string, dev = false): Promise<BuildOptions[]> {
  const raw = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
  const m = validateManifest(raw).manifest;
  if (!m) throw new Error("invalid plugin.json (run `fluxplugin validate`)");
  const out: BuildOptions[] = [];
  const common = { bundle: true, sourcemap: dev, // sourcemaps only while developing; a built/published plugin never has them
     logLevel: "warning" as const, plugins: [sharedModulesPlugin()], jsx: "automatic" as const, loader: { ".module.css": "local-css" as const } };
  if (m.main) {
    const entry = await firstExisting(root, ["src/main.ts", "src/main.js"]);
    if (!entry) throw new Error("manifest declares `main` but src/main.ts was not found");
    out.push({ ...common, entryPoints: [entry], outfile: path.join(root, m.main), platform: "node", format: "esm", target: "node20", external: ["node:*", "electron"] });
  }
  if (m.renderer) {
    const entry = await firstExisting(root, ["src/renderer.tsx", "src/renderer.ts", "src/renderer.jsx", "src/renderer.js"]);
    if (!entry) throw new Error("manifest declares `renderer` but src/renderer.tsx was not found");
    out.push({ ...common, entryPoints: [entry], outfile: path.join(root, m.renderer), platform: "browser", format: "esm", target: "chrome120" });
  }
  for (const css of m.styles ?? []) {
    // tailwind.css is compiled by the Tailwind CLI (see buildPlugin), never by esbuild (it would overwrite the output).
    if (path.basename(css) === "tailwind.css") continue;
    const entry = path.join(root, "src/styles", path.basename(css));
    if (await exists(entry)) out.push({ ...common, plugins: [], entryPoints: [entry], outfile: path.join(root, css) });
  }
  return out;
}

export async function buildPlugin(root: string, watch = false, log = console.log): Promise<() => Promise<void>> {
  const opts = await buildOptions(root, watch);
  // Optional Tailwind: src/styles/tailwind.css → dist/tailwind.css (list "./dist/tailwind.css" in manifest.styles).
  const twIn = path.join(root, "src/styles/tailwind.css");
  const stopTw = (await exists(twIn)) ? compileTailwind({ cwd: root, input: twIn, output: path.join(root, "dist/tailwind.css"), watch, searchFrom: [process.cwd(), path.dirname(path.dirname(root))] }, log) : () => {};
  if (!watch) {
    for (const o of opts) await build(o);
    log(`built ${opts.length} bundle(s) in ${root}`);
    return async () => stopTw();
  }
  const ctxs = await Promise.all(opts.map((o) => context(o)));
  await Promise.all(ctxs.map((c) => c.watch()));
  log(`watching ${root} (${ctxs.length} bundles)`);
  return async () => (stopTw(), void (await Promise.all(ctxs.map((c) => c.dispose()))));
}
