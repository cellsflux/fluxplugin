import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { MainFramework, copyPluginRuntime } from "../main/index.js";
import { buildHost } from "./host.js";
import { loadConfig } from "./config.js";

async function pluginFolders(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const n of (await fs.readdir(dir).catch(() => [])).sort()) if (existsSync(path.join(dir, n, "plugin.json"))) out.push(path.join(dir, n));
  return out;
}

/** Copies every plugin's runtime files (no src, no .ts, no sourcemaps) to `outDir/<folder>`. Returns the plugin count. */
export async function stagePlugins(cwd: string, outDir: string, log: (m: string) => void = console.log): Promise<number> {
  const cfg = await loadConfig({}, cwd);
  await fs.rm(outDir, { recursive: true, force: true });
  const dirs = await pluginFolders(cfg.pluginsDir);
  for (const d of dirs) {
    const files = await copyPluginRuntime(d, path.join(outDir, path.basename(d)));
    log(`  ${path.basename(d)}: ${files.length} runtime files`);
  }
  await fs.mkdir(outDir, { recursive: true });
  return dirs.length;
}

/** Builds the app and packages it into an installer/executable with electron-builder (current OS by default). */
export async function distApp(cwd: string, opts: { win?: boolean; mac?: boolean; linux?: boolean; dir?: boolean; log?: (m: string) => void } = {}): Promise<number> {
  const log = opts.log ?? console.log;
  log("1/3 building the app…");
  await buildHost(cwd, { log });
  log("2/3 staging plugins (runtime files only)…");
  const n = await stagePlugins(cwd, path.join(cwd, ".flux-build/plugins"), log);
  log(`3/3 packaging (${n} plugin(s) bundled)…`);
  let cli: string;
  try {
    const pj = createRequire(path.join(cwd, "package.json")).resolve("electron-builder/package.json");
    const bin = (JSON.parse(await fs.readFile(pj, "utf8")) as { bin?: string | Record<string, string> }).bin;
    cli = path.join(path.dirname(pj), typeof bin === "string" ? bin : (bin?.["electron-builder"] ?? "cli.js"));
  } catch {
    throw new Error('electron-builder is not installed: run "npm install -D electron-builder"');
  }
  const args = [cli, "--config", existsSync(path.join(cwd, "electron-builder.yml")) ? "electron-builder.yml" : "package.json"];
  if (opts.dir) args.push("--dir");
  for (const t of ["win", "mac", "linux"] as const) if (opts[t]) args.push(`--${t}`);
  return await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit", env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env["CSC_IDENTITY_AUTO_DISCOVERY"] ?? "false" } });
    child.on("exit", (c) => resolve(c ?? 1));
  });
}

/**
 * Extracts the app as a static website: the built renderer, every plugin's runtime files and a `bootstrap.json` describing them.
 * Serve the folder with any static host. Only the browser side runs (no main-process code): renderer-only plugins work fully.
 */
export async function exportWebsite(cwd: string, outDir: string, log: (m: string) => void = console.log): Promise<{ plugins: number; out: string }> {
  await buildHost(cwd, { log });
  const out = path.resolve(outDir);
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  for (const f of ["index.html", "renderer.js", "renderer.css", "tailwind.css"]) if (existsSync(path.join(cwd, "dist", f))) await fs.copyFile(path.join(cwd, "dist", f), path.join(out, f));
  const cfg = await loadConfig({}, cwd);
  let count = 0;
  for (const d of await pluginFolders(cfg.pluginsDir)) {
    const id = (JSON.parse(await fs.readFile(path.join(d, "plugin.json"), "utf8")) as { id: string }).id;
    await copyPluginRuntime(d, path.join(out, "plugins", id));
    count++;
  }
  const tmp = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "flux-export-"));
  try {
    const fw = new MainFramework({ pluginDirs: [path.join(out, "plugins")], dataDir: tmp, assetUrl: (id, rel) => `./plugins/${id}/${rel.replace(/^\.\//, "")}` });
    await fw.manager.init();
    await fw.scan(); // reads manifests only: no plugin code runs during export
    await fs.writeFile(path.join(out, "bootstrap.json"), JSON.stringify(fw.bootstrap(), null, 2));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  await fs.writeFile(path.join(out, "README.txt"), "Static export. Serve this folder over HTTP(S) (e.g. `npx serve .`); opening index.html from disk will not work.\nOnly the browser side runs here: plugins that need main-process code are listed but their IPC calls fail.\n");
  log(`exported ${count} plugin(s) → ${out}`);
  return { plugins: count, out };
}
