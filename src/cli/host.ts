import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build, context, type BuildOptions } from "esbuild";
import { buildPlugin } from "./build.js";
import { compileTailwind } from "./tailwind.js";
import { loadConfig } from "./config.js";

const exists = (f: string) => fs.access(f).then(() => true, () => false);

export async function isHostProject(cwd: string): Promise<boolean> {
  if (await exists(path.join(cwd, "fluxplugin.config.json"))) return true;
  return (await exists(path.join(cwd, "src/app/renderer/index.tsx"))) || (await exists(path.join(cwd, "src/renderer.tsx")));
}

const nodeBanner = { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" };

const pick = (cwd: string, ...rels: string[]): string => {
  for (const r of rels) if (existsSync(path.join(cwd, r))) return path.join(cwd, r);
  return path.join(cwd, rels[0]!);
};

function hostBuilds(cwd: string, outDir: string, dev: boolean): BuildOptions[] {
  const common: BuildOptions = { absWorkingDir: cwd, bundle: true, sourcemap: dev, logLevel: "warning", jsx: "automatic", define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") } };
  const renderer = pick(cwd, "src/app/renderer/index.tsx", "src/renderer.tsx");
  const main = pick(cwd, "src/app/main/index.ts", "src/main.ts");
  const preload = pick(cwd, "src/app/preload/index.ts", "src/preload.ts");
  const web = pick(cwd, "src/app/main/web.ts", "src/web.ts");
  return [
    { ...common, entryPoints: [renderer], outfile: path.join(outDir, "renderer.js"), platform: "browser", format: "esm", target: "chrome120" },
    { ...common, entryPoints: [main], outfile: path.join(outDir, "main.cjs"), platform: "node", format: "cjs", target: "node20", external: ["electron"] },
    { ...common, entryPoints: [preload], outfile: path.join(outDir, "preload.cjs"), platform: "node", format: "cjs", target: "node20", external: ["electron"] },
    { ...common, entryPoints: [web], outfile: path.join(outDir, "web.mjs"), platform: "node", format: "esm", target: "node20", external: ["electron"], banner: nodeBanner },
  ];
}

async function pluginDirs(cwd: string, pluginsDir: string): Promise<string[]> {
  const names = await fs.readdir(pluginsDir).catch(() => []);
  const out: string[] = [];
  for (const n of names.sort()) if (await exists(path.join(pluginsDir, n, "plugin.json"))) out.push(path.join(pluginsDir, n));
  void cwd;
  return out;
}

/** Bundles the host (renderer, main, preload, web) and every plugin in `pluginsDir`. */
export async function buildHost(cwd: string, opts: { watch?: boolean; log?: (m: string) => void } = {}): Promise<() => Promise<void>> {
  const log = opts.log ?? console.log;
  const cfgFile = JSON.parse(await fs.readFile(path.join(cwd, "fluxplugin.config.json"), "utf8").catch(() => "{}")) as { outDir?: string };
  const cfg = await loadConfig({}, cwd);
  const outDir = path.resolve(cwd, cfgFile.outDir ?? "dist");
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(pick(cwd, "src/app/renderer/index.html", "src/index.html"), path.join(outDir, "index.html"));
  const disposers: (() => Promise<void>)[] = [];
  const twIn = path.join(cwd, "src/app/renderer/styles/tailwind.css");
  if (await exists(twIn)) {
    const stop = compileTailwind({ cwd, input: twIn, output: path.join(outDir, "tailwind.css"), watch: opts.watch }, log);
    disposers.push(async () => stop());
  }
  const opts2 = hostBuilds(cwd, outDir, !!opts.watch);
  if (opts.watch) {
    const ctxs = await Promise.all(opts2.map((o) => context(o)));
    await Promise.all(ctxs.map((c) => c.rebuild())); // first build must be finished before anything starts
    await Promise.all(ctxs.map((c) => c.watch()));
    disposers.push(async () => void (await Promise.all(ctxs.map((c) => c.dispose()))));
  } else for (const o of opts2) await build(o);
  for (const dir of await pluginDirs(cwd, cfg.pluginsDir)) {
    try {
      disposers.push(await buildPlugin(dir, !!opts.watch, log));
    } catch (e) {
      log(`! plugin ${path.basename(dir)} not built: ${(e as Error).message}`);
    }
  }
  log(`host built → ${path.relative(cwd, outDir) || "."}`);
  return async () => void (await Promise.all(disposers.map((d) => d())));
}

function electronBinary(cwd: string): { bin?: string; error?: string } {
  try {
    const p = createRequire(path.join(cwd, "package.json"))("electron") as unknown;
    if (typeof p === "string" && existsSync(p)) return { bin: p };
    return { error: "the Electron binary was not found" };
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0] };
  }
}

/**
 * Returns the Electron binary, downloading it if the package manager skipped Electron's postinstall
 * (npm 11.16+/12 block install scripts by default, pnpm 10 too). This is the same download `npm i electron` does.
 */
export function ensureElectron(cwd: string, log: (m: string) => void = console.log): { bin?: string; error?: string } {
  const first = electronBinary(cwd);
  if (first.bin) return first;
  let pkgDir: string;
  try {
    pkgDir = path.dirname(createRequire(path.join(cwd, "package.json")).resolve("electron/package.json"));
  } catch {
    return { error: "Electron is not installed in this project" };
  }
  const installJs = path.join(pkgDir, "install.js");
  if (!existsSync(installJs)) return first;
  log("Electron's binary is missing (your package manager blocked its install script) → downloading it now…");
  const r = spawnSync(process.execPath, [installJs], { cwd: pkgDir, stdio: "inherit" });
  if (r.status !== 0) return { error: "the Electron download failed (network or proxy?). Retry, or set ELECTRON_MIRROR" };
  return electronBinary(cwd);
}

/** Linux only: Chromium's sandbox needs a setuid-root helper; without it (or when running as root) Electron refuses to start. */
function needsNoSandbox(bin: string): boolean {
  if (process.platform !== "linux") return false;
  if (process.getuid?.() === 0) return true;
  try {
    const st = statSync(path.join(path.dirname(bin), "chrome-sandbox"));
    return !(st.uid === 0 && (st.mode & 0o4000) !== 0);
  } catch {
    return false;
  }
}

/** Starts the app: Electron by default, browser mode with `web`. Throws a readable error if Electron cannot run. */
export function startApp(cwd: string, opts: { web?: boolean; dev?: boolean; port?: number; log?: (m: string) => void } = {}): { child: ChildProcess; mode: "electron" | "web" } {
  const log = opts.log ?? console.log;
  const env = { ...process.env, FLUXPLUGIN_PROJECT: cwd, ...(opts.dev ? { FLUXPLUGIN_DEV: "1" } : {}), ...(opts.port ? { PORT: String(opts.port) } : {}) };
  if (opts.web) return { child: spawn(process.execPath, [path.join(cwd, "dist/web.mjs")], { cwd, env, stdio: "inherit" }), mode: "web" };
  const { bin, error } = ensureElectron(cwd, log);
  if (!bin) throw new Error(`cannot start Electron: ${error}.\n  Try:  npm install -D electron   then   fluxplugin doctor\n  Or run in a browser:  fluxplugin ${opts.dev ? "dev" : "start"} --web`);
  // Extra Electron/Chromium flags for debugging, e.g. FLUXPLUGIN_ELECTRON_ARGS="--remote-debugging-port=9222".
  const args = [...(process.env["FLUXPLUGIN_ELECTRON_ARGS"]?.split(" ").filter(Boolean) ?? []), path.join(cwd, "dist/main.cjs")];
  if (needsNoSandbox(bin)) {
    args.unshift("--no-sandbox");
    log("! Linux: Electron's sandbox helper is not configured (or you run as root) → starting with --no-sandbox.\n  To fix permanently: sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox");
  }
  const started = Date.now();
  const child = spawn(bin, args, { cwd, env, stdio: "inherit" });
  child.on("exit", (code) => {
    if (code && Date.now() - started < 5000) log(`Electron exited with code ${code} right after starting. Scroll up for its error, or try:  fluxplugin dev --web`);
  });
  return { child, mode: "electron" };
}
