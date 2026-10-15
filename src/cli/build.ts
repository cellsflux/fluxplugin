import { existsSync, promises as fs, watch as fsWatch } from "node:fs";
import path from "node:path";
import { build, context, type BuildOptions } from "esbuild";
import { validateManifest } from "../core/index.js";
import { copyPluginRuntime } from "../main/index.js";
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
     logLevel: "warning" as const, plugins: [sharedModulesPlugin()], jsx: "automatic" as const, loader: {
      ".module.css": "local-css" as const,
      // Images and fonts imported by the plugin (or its libraries) are inlined, so dist/ stays self-contained.
      ".png": "dataurl" as const, ".jpg": "dataurl" as const, ".jpeg": "dataurl" as const, ".gif": "dataurl" as const, ".webp": "dataurl" as const,
      ".svg": "dataurl" as const, ".woff": "dataurl" as const, ".woff2": "dataurl" as const, ".ttf": "dataurl" as const,
    } };
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
    await ensureRendererCss(root);
    await hintMissingDeps(root, log);
    log(`built ${opts.length} bundle(s) in ${root}`);
    return async () => stopTw();
  }
  const ctxs = await Promise.all(opts.map((o) => context(o)));
  await Promise.all(ctxs.map((c) => c.rebuild())); // first build must be finished before anything uses dist/
  await ensureRendererCss(root);
  await Promise.all(ctxs.map((c) => c.watch()));
  log(`watching ${root} (${ctxs.length} bundles)`);
  return async () => (stopTw(), void (await Promise.all(ctxs.map((c) => c.dispose()))));
}

/** CSS imported by the renderer entry (including from libraries) is emitted as dist/renderer.css: make sure the manifest loads it. */
async function ensureRendererCss(root: string): Promise<void> {
  if (!(await exists(path.join(root, "dist/renderer.css")))) return;
  const file = path.join(root, "plugin.json");
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as { styles?: string[] };
  const styles = raw.styles ?? [];
  if (styles.some((s) => s.replace(/^\.\//, "") === "dist/renderer.css")) return;
  raw.styles = [...styles, "./dist/renderer.css"];
  await fs.writeFile(file, JSON.stringify(raw, null, 2));
}

async function hintMissingDeps(root: string, log: (m: string) => void): Promise<void> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    if (Object.keys(pkg.dependencies ?? {}).length && !(await exists(path.join(root, "node_modules")))) log(`! ${path.basename(root)} lists dependencies but has no node_modules: run "npm install" in ${root}`);
  } catch {
    /* no package.json */
  }
}

/**
 * Keeps `<host>/plugins/<id>` in sync with this plugin project (runtime files only): lets you develop a plugin as its own
 * project and watch it run in the main app (which hot-reloads it). Returns a function that stops syncing.
 */
export async function linkPluginToHost(root: string, hostDir: string, log: (m: string) => void = console.log): Promise<() => void> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8")) as { id: string };
  const target = path.join(path.resolve(hostDir), "plugins", manifest.id);
  const sync = async (): Promise<void> => {
    try {
      const copied = await copyPluginRuntime(root, target);
      const keep = new Set(copied);
      const walk = async (rel: string): Promise<void> => {
        for (const e of await fs.readdir(path.join(target, rel), { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(r);
          else if (!keep.has(r)) await fs.rm(path.join(target, r), { force: true });
        }
      };
      await walk("");
      log(`↪ synced ${copied.length} files to ${path.relative(process.cwd(), target) || target}`);
    } catch (e) {
      log(`! sync failed: ${(e as Error).message}`);
    }
  };
  await sync();
  let timer: NodeJS.Timeout | undefined;
  const watchers = [path.join(root, "dist"), path.join(root, "assets"), root].filter((d) => existsSync(d)).map((d) =>
    fsWatch(d, { recursive: d !== root }, (_e, name) => {
      if (d === root && name !== "plugin.json" && name !== "README.md") return;
      clearTimeout(timer);
      timer = setTimeout(() => void sync(), 250);
    }),
  );
  return () => watchers.forEach((w) => w.close());
}
