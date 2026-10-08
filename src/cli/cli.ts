import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateManifest } from "../core/index.js";
import { JsonStateFile, LocalRegistry, PluginInstaller, computeIntegrity, copyDir, createRegistries, extractTarGz, generateSigningKeyPair, verifyPlugin } from "../main/index.js";
import { buildPlugin } from "./build.js";
import { buildHost, ensureElectron, isHostProject, startApp } from "./host.js";
import { hostFiles } from "./host-templates.js";
import { packagePlugin } from "./package.js";
import { publishPlugin } from "./publish.js";
import { storeAdd, storeInit } from "./store.js";
import { loadConfig } from "./config.js";
import { TEMPLATES, varsFromName, withTailwind, type TemplateName } from "./templates.js";

const HELP = `fluxplugin <command>

  init [dir] [--tailwindcss]      create a new app (Electron + React) that supports plugins
  doctor                          check Node, Electron, esbuild, Tailwind and fix what it can
  dev [--web]                     run your app with plugin hot reload (Electron, or a browser with --web)
  build                           bundle your app (in an app folder) or a plugin (in a plugin folder)
  start [--web]                   run the built app
  plugin new <name> [-t basic|dashboard|backend] [--tailwindcss]   scaffold a plugin (alias: create)
  validate [dir]                  check a plugin manifest, entries and integrity
  publish [dir] [--repo o/r] [--dry-run]   publish a plugin to the store (GitHub release + topic)
  search [query]                  search the configured stores
  install <id[@version]|dir|.tgz> install a plugin from a store, a folder or a package
  store init <dir>                create your own store (index.json) — host it anywhere
  store add <pkg.tgz> [--dir d] [--base-url url]   add a package to your store
  package [dir] [--out d] [--sign-key file]   build + integrity (+ signature) + .tgz
  install <dir|.tgz> [--dir plugins]   uninstall <id>   enable <id>   disable <id>   list
  keygen [--out name]    create an ed25519 signing key pair
  tailwind [--dir plugins] [--out file]   generate @source lines for Tailwind v4`;

const log = (...a: unknown[]) => console.log(...a);
export async function readManifest(root: string) {
  return JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8")) as Record<string, unknown>;
}

export async function run(argv: string[]): Promise<number> {
  const { values: f, positionals: pos } = parseArgs({
    args: argv, allowPositionals: true,
    options: { template: { type: "string", short: "t" }, out: { type: "string" }, dir: { type: "string" }, data: { type: "string" }, "sign-key": { type: "string" }, help: { type: "boolean", short: "h" }, web: { type: "boolean" }, port: { type: "string" }, name: { type: "string" }, "no-sample": { type: "boolean" }, tailwindcss: { type: "boolean" }, repo: { type: "string" }, token: { type: "string" }, "dry-run": { type: "boolean" }, "base-url": { type: "string" } },
  });
  let [cmd, arg] = pos;
  if (cmd === "store") { cmd = "store:" + (pos[1] ?? ""); arg = pos[2]; }
  if (cmd === "plugin") { const sub = pos[1]; if (sub !== "new") throw new Error("usage: fluxplugin plugin new <name>"); cmd = "create"; arg = pos[2]; }
  if (!cmd || f.help) return log(HELP), cmd ? 0 : 1;
  const root = path.resolve(arg ?? ".");
  try {
    switch (cmd) {
      case "init": {
        const target = path.resolve(arg ?? ".");
        const entries = await fs.readdir(target).catch(() => []);
        if (entries.length) throw new Error(`${target} is not empty`);
        const name = (f.name ?? path.basename(target)).toLowerCase().replace(/[^a-z0-9-_.]+/g, "-");
        const files = hostFiles({ name, fluxSpec: process.env["FLUXPLUGIN_SPEC"] ?? `^${await ownVersion()}`, electron: await latestElectron(), tailwind: !!f.tailwindcss }, !f["no-sample"]);
        for (const [rel, content] of Object.entries(files)) {
          await fs.mkdir(path.dirname(path.join(target, rel)), { recursive: true });
          await fs.writeFile(path.join(target, rel), content);
        }
        const rel = path.relative(process.cwd(), target) || ".";
        log(`✔ created ${name} in ${target}\n\nNext steps:\n  ${rel === "." ? "" : `cd ${rel}\n  `}npm install\n  npm run dev:web     # browser mode (no Electron needed)\n  npm run dev         # Electron\n\nAdd a plugin:  npm run plugin:new my-plugin -- -t backend`);
        return 0;
      }
      case "create": {
        if (!arg) throw new Error("usage: fluxplugin plugin new <name> [-t basic|dashboard|backend]");
        const tpl = (f.template ?? "basic") as TemplateName;
        if (!(tpl in TEMPLATES)) throw new Error(`unknown template "${tpl}"`);
        // Inside an app folder, new plugins go to ./plugins by default.
        const base = (await isHostProject(process.cwd())) && !path.isAbsolute(arg) && !arg.includes("/") ? path.join((await loadConfig({}, process.cwd())).pluginsDir, arg) : path.resolve(arg);
        if (await fs.stat(base).catch(() => null)) throw new Error(`${base} already exists`);
        const vars = varsFromName(path.basename(base));
        let files = TEMPLATES[tpl](vars);
        if (f.tailwindcss) files = withTailwind(files, vars);
        for (const [rel, content] of Object.entries(files)) {
          await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
          await fs.writeFile(path.join(base, rel), content);
        }
        log(`✔ created ${tpl} plugin in ${base}\n  next: fluxplugin build ${path.relative(process.cwd(), base)}`);
        return 0;
      }
      case "build": {
        if (!arg && (await isHostProject(process.cwd()))) { await buildHost(process.cwd()); return 0; }
        await buildPlugin(root);
        return 0;
      }
      case "dev": {
        const cwd = process.cwd();
        if (arg || !(await isHostProject(cwd))) { await buildPlugin(root, true); await new Promise(() => {}); }
        const dispose = await buildHost(cwd, { watch: true });
        const { child, mode } = startApp(cwd, { web: f.web, dev: true, port: f.port ? Number(f.port) : undefined });
        child.on("error", (e) => console.error(`error: ${e.message}`));
        log(`running in ${mode} mode — edit a plugin and it reloads; Ctrl+C to stop`);
        const stop = () => { child.kill(); void dispose().finally(() => process.exit(0)); };
        process.on("SIGINT", stop); process.on("SIGTERM", stop);
        return await new Promise<number>((r) => child.on("exit", (c) => r(c ?? 0)));
      }
      case "start": {
        const cwd = process.cwd();
        if (!(await fs.stat(path.join(cwd, "dist/index.html")).catch(() => null))) throw new Error("nothing built yet: run `fluxplugin build` first");
        const { child } = startApp(cwd, { web: f.web, port: f.port ? Number(f.port) : undefined });
        return await new Promise<number>((r) => child.on("exit", (c) => r(c ?? 0)));
      }
      case "doctor": return await doctor(process.cwd());
      case "validate": return await validate(root);
      case "package": return (await packagePlugin(root, { out: f.out, signKey: f["sign-key"] }), 0);
      case "publish":
        await publishPlugin(root, { repo: f.repo, token: f.token, signKey: f["sign-key"], dryRun: f["dry-run"] });
        return 0;
      case "search": {
        const cfg = await loadConfig(f);
        const regs = createRegistries(cfg.stores);
        const res = await Promise.allSettled(regs.map((r) => r.search(arg)));
        let n = 0;
        res.forEach((r, i) => {
          if (r.status === "rejected") return void log(`! ${regs[i]!.name}: ${(r.reason as Error).message}`);
          for (const e of r.value) (n++, log(`${e.id}@${e.version}  ${e.name}${e.description ? " — " + e.description : ""}  [${e.source}]`));
        });
        if (!n) log("no plugins found");
        return 0;
      }
      case "store:init": await storeInit(path.resolve(arg ?? "store")); log(`✔ store created in ${path.resolve(arg ?? "store")} (see its README.md)`); return 0;
      case "store:add": {
        if (!arg) throw new Error("usage: store add <package.tgz> [--dir store] [--base-url https://…]");
        const r = await storeAdd(path.resolve(arg), path.resolve(f.dir ?? "store"), f["base-url"]);
        log(`✔ added ${r.id}@${r.version} to ${path.resolve(f.dir ?? "store")}/index.json`);
        return 0;
      }
      case "keygen": {
        const k = generateSigningKeyPair();
        const base = f.out ?? "flux-signing";
        await fs.writeFile(`${base}.private.key`, k.privateKey, { mode: 0o600 });
        await fs.writeFile(`${base}.public.key`, k.publicKey);
        log(`wrote ${base}.private.key (keep secret) and ${base}.public.key (distribute to hosts as a trusted key)`);
        return 0;
      }
      case "tailwind": {
        const cfg = await loadConfig(f);
        const names = (await fs.readdir(cfg.pluginsDir).catch(() => [])).sort();
        const lines = names.map((n) => `@source "${path.join(cfg.pluginsDir, n, "src").replace(/\\/g, "/")}";`);
        const css = `/* generated by fluxplugin tailwind */\n${lines.join("\n")}\n`;
        if (f.out) await fs.writeFile(f.out, css); else log(css);
        return 0;
      }
      case "install": case "uninstall": case "enable": case "disable": case "list": return await manage(cmd, arg, f);
      default: log(HELP); return 1;
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

async function validate(root: string): Promise<number> {
  const raw = await readManifest(root);
  const v = validateManifest(raw);
  let bad = !v.ok;
  v.issues.forEach((i) => log(`✖ ${i.path || "<root>"}: ${i.message}`));
  v.warnings.forEach((w) => log(`! ${w}`));
  if (v.manifest) {
    for (const rel of [v.manifest.main, v.manifest.renderer, ...(v.manifest.styles ?? [])].filter(Boolean) as string[])
      if (!(await fs.stat(path.join(root, rel)).catch(() => null))) (log(`✖ missing file ${rel} (run build)`), (bad = true));
    try { await verifyPlugin(root, raw, v.manifest); } catch (e) { log(`✖ ${(e as Error).message}`); bad = true; }
  }
  log(bad ? "invalid" : `✔ ${v.manifest?.id}@${v.manifest?.version} is valid`);
  return bad ? 1 : 0;
}

async function manage(cmd: string, arg: string | undefined, f: { dir?: string; data?: string }): Promise<number> {
  const cfg = await loadConfig(f);
  const state = new JsonStateFile(path.join(cfg.dataDir, "plugins-state.json"));
  const inst = new PluginInstaller(cfg.pluginsDir, path.join(cfg.dataDir, "backups"));
  if (cmd === "list") {
    const { disabled } = await state.readAll();
    for (const m of await inst.installed()) log(`${disabled.includes(m.id) ? "○" : "●"} ${m.id}@${m.version}  ${m.name}`);
    return 0;
  }
  if (!arg) throw new Error(`usage: ${cmd} <${cmd === "install" ? "dir|.tgz" : "id"}>`);
  if (cmd === "install" && arg && !arg.endsWith(".tgz") && !(await fs.stat(arg).catch(() => null))) {
    const [id, version] = arg.split("@") as [string, string | undefined];
    const store = new PluginInstaller(cfg.pluginsDir, path.join(cfg.dataDir, "backups"), createRegistries(cfg.stores));
    const found = (await store.search(id)).filter((e) => e.id === id && (!version || e.version === version));
    if (!found.length) throw new Error(`"${arg}" was not found in your stores (${cfg.stores.map((s) => s.type).join(", ")}). Try: fluxplugin search ${id}`);
    const best = found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]!;
    const r = await store.install(best);
    log(`✔ installed ${r.id}@${r.version} from ${best.source}${r.previousVersion ? ` (was ${r.previousVersion}; rollback available)` : ""}\n  permissions it asks for: ${best.permissions.join(", ") || "none"}`);
    return 0;
  }
  if (cmd === "install") {
    const tmp = path.join(cfg.dataDir, ".install", String(Date.now()));
    if (arg.endsWith(".tgz")) await extractTarGz(await fs.readFile(arg), tmp); else await copyDir(path.resolve(arg), tmp);
    const v = validateManifest(await readManifest(tmp));
    if (!v.manifest) throw new Error("invalid plugin: " + v.issues.map((i) => i.message).join("; "));
    const reg = new LocalRegistry(path.dirname(tmp), "cli");
    inst.addRegistry(reg);
    const [entry] = (await reg.search(v.manifest.id)).filter((e) => e.id === v.manifest!.id);
    const r = await inst.install({ ...entry!, location: tmp });
    await fs.rm(tmp, { recursive: true, force: true });
    log(`installed ${r.id}@${r.version}${r.previousVersion ? ` (was ${r.previousVersion}; rollback available)` : ""}`);
  } else if (cmd === "uninstall") { await inst.uninstall(arg); log(`uninstalled ${arg}`); }
  else {
    await state.update((s) => ({ disabled: cmd === "disable" ? [...new Set([...s.disabled, arg])] : s.disabled.filter((x) => x !== arg) }));
    log(`${cmd}d ${arg}`);
  }
  return 0;
}


async function ownVersion(): Promise<string> {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const j = JSON.parse(await fs.readFile(new URL(rel, import.meta.url), "utf8")) as { name?: string; version?: string };
      if (j.name === "fluxplugin" && j.version) return j.version;
    } catch { /* try next */ }
  }
  return "1.0.0";
}

async function latestElectron(): Promise<string> {
  try {
    const r = await fetch("https://registry.npmjs.org/electron/latest", { signal: AbortSignal.timeout(4000) });
    const j = (await r.json()) as { version?: string };
    if (j.version && /^\d+\.\d+\.\d+$/.test(j.version)) return `^${j.version}`;
  } catch { /* offline: use the known-good version below */ }
  return "^44.5.1";
}

async function doctor(cwd: string): Promise<number> {
  let bad = false;
  const ok = (m: string) => log(`✔ ${m}`);
  const ko = (m: string) => (log(`✖ ${m}`), (bad = true));
  Number(process.versions.node.split(".")[0]) >= 20 ? ok(`Node ${process.versions.node}`) : ko(`Node ${process.versions.node} (need >= 20)`);
  if (!(await isHostProject(cwd))) { log("! not inside a fluxplugin app folder (run this where package.json and src/app are)"); return bad ? 1 : 0; }
  const e = ensureElectron(cwd, log);
  e.bin ? ok(`Electron binary: ${path.relative(cwd, e.bin) || e.bin}`) : ko(`Electron: ${e.error}\n    fix: npm install -D electron`);
  try { (await import("esbuild")).version ? ok("esbuild") : ko("esbuild"); } catch { ko("esbuild is not available"); }
  const hasTw = await fs.stat(path.join(cwd, "src/app/renderer/styles/tailwind.css")).then(() => true, () => false);
  if (hasTw) { const { resolveTailwindCli } = await import("./tailwind.js"); resolveTailwindCli([cwd]) ? ok("Tailwind CLI") : ko("Tailwind CLI missing: npm install -D tailwindcss @tailwindcss/cli"); }
  const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8").catch(() => "{}")) as { allowScripts?: Record<string, boolean> };
  if (!pkg.allowScripts?.["electron"]) log('! package.json has no "allowScripts": {"electron": true}. npm 12 blocks Electron\'s postinstall without it (fluxplugin downloads the binary for you, but add it for clean installs).');
  log(bad ? "\nSome checks failed." : "\nAll good.");
  return bad ? 1 : 0;
}
