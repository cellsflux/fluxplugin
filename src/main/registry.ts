import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { compareVersions, validateManifest, type PluginManifest } from "../core/index.js";
import { MANIFEST_FILE } from "./discover.js";
import { createTarGz, extractTarGz } from "./tar.js";

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  permissions: string[];
  /** Opaque location understood by the registry that produced the entry. */
  location: string;
  source: string;
  /** sha256 hex of the archive when the registry knows it. */
  sha256?: string;
  homepage?: string;
  stars?: number;
  icon?: string;
}

/**
 * Abstraction over where plugins come from. Implement it for npm, GitHub releases, a private HTTP registry,
 * or a marketplace. The framework only needs `search` and `fetch` (a directory with a plugin.json).
 */
export interface PluginRegistry {
  readonly name: string;
  search(query?: string): Promise<RegistryEntry[]>;
  /** Materializes a plugin into `destDir` (which does not exist yet). Returns its manifest. */
  fetch(entry: RegistryEntry, destDir: string): Promise<PluginManifest>;
}

export async function readPluginManifest(dir: string): Promise<{ raw: Record<string, unknown>; manifest: PluginManifest }> {
  const raw = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8"));
  const v = validateManifest(raw);
  if (!v.manifest) throw new Error(`invalid manifest: ${v.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  return { raw, manifest: v.manifest };
}

const toEntry = (m: PluginManifest, location: string, source: string, sha256?: string): RegistryEntry => ({
  id: m.id,
  name: m.name,
  version: m.version,
  description: m.description,
  author: typeof m.author === "string" ? m.author : m.author?.name,
  permissions: m.permissions ?? [],
  location,
  source,
  sha256,
});

const RUNTIME_DIRS = new Set(["dist", "assets", "images", "docs"]);
const RUNTIME_FILES = /^(plugin\.json|readme(\.[a-z]+)?|license(\.[a-z]+)?|changelog(\.[a-z]+)?|icon\.(png|svg|jpg|webp))$/i;
const SOURCE_FILE = /\.(tsx?|jsx|map|scss|sass|less)$/i;

/**
 * Copies only what a *distributed* plugin needs at runtime: plugin.json, dist/, assets/, README/LICENSE/CHANGELOG and any
 * file the manifest references. Source code (`src/`, .ts/.tsx, sourcemaps), node_modules and tooling files never ship.
 */
export async function copyPluginRuntime(src: string, dest: string): Promise<string[]> {
  const copied: string[] = [];
  const manifest = JSON.parse(await fs.readFile(path.join(src, MANIFEST_FILE), "utf8")) as Record<string, any>;
  const referenced = new Set(
    [manifest["main"], manifest["preload"], manifest["renderer"], manifest["icon"], manifest["banner"], manifest["readme"], ...(manifest["styles"] ?? []), ...(manifest["screenshots"] ?? [])]
      .filter((x): x is string => typeof x === "string")
      .map((x) => path.normalize(x).replace(/^(\.\/|\.\\)/, "")),
  );
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(src, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (rel === "" ? RUNTIME_DIRS.has(e.name) : true) await walk(r);
      } else if (e.isFile()) {
        const top = r.split(path.sep)[0]!;
        const ok = referenced.has(r) || (rel === "" ? RUNTIME_FILES.test(e.name) : RUNTIME_DIRS.has(top) && !SOURCE_FILE.test(e.name));
        if (!ok || (SOURCE_FILE.test(e.name) && !referenced.has(r))) continue;
        await fs.mkdir(path.dirname(path.join(dest, r)), { recursive: true });
        await fs.copyFile(path.join(src, r), path.join(dest, r));
        copied.push(r.split(path.sep).join("/"));
      }
    }
  };
  await fs.mkdir(dest, { recursive: true });
  await walk("");
  return copied;
}

export async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

/** Shape of a store catalog (`index.json`). Used by HTTP stores, GitHub catalog stores and `fluxplugin store add`. */
export interface StoreIndex {
  plugins: { id: string; name?: string; version: string; description?: string; author?: string; permissions?: string[]; url: string; sha256?: string; homepage?: string; icon?: string }[];
}

export function entriesFromIndex(index: StoreIndex, baseUrl: string, source: string, query = ""): RegistryEntry[] {
  const q = query.toLowerCase();
  return (index.plugins ?? [])
    .filter((p) => p && typeof p.id === "string" && typeof p.version === "string" && typeof p.url === "string")
    .filter((p) => !q || `${p.id} ${p.name ?? ""} ${p.description ?? ""}`.toLowerCase().includes(q))
    .map((p) => ({
      id: p.id, name: p.name ?? p.id, version: p.version, description: p.description, author: p.author,
      permissions: p.permissions ?? [], location: new URL(p.url, baseUrl).href, source, sha256: p.sha256, homepage: p.homepage, icon: p.icon,
    }));
}

/** Removes everything that is not runtime code from an extracted plugin: sources, TypeScript, sourcemaps, node_modules. */
export async function pruneNonRuntime(dir: string): Promise<string[]> {
  const removed: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      const abs = path.join(dir, r);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || (rel === "" && (e.name === "src" || e.name === ".git"))) (await fs.rm(abs, { recursive: true, force: true }), removed.push(r + "/"));
        else await walk(r);
      } else if (/\.(map|tsx?|scss|sass|less)$/i.test(e.name) && !/\.d\.ts$/i.test(e.name)) (await fs.rm(abs, { force: true }), removed.push(r));
    }
  };
  await walk("");
  return removed;
}

/** A directory whose sub-directories are plugins (e.g. a shared network folder or a repo checkout). */
export class LocalRegistry implements PluginRegistry {
  readonly name: string;
  constructor(private readonly dir: string, name = `local:${dir}`) {
    this.name = name;
  }
  async search(query = ""): Promise<RegistryEntry[]> {
    const q = query.toLowerCase();
    const out: RegistryEntry[] = [];
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    for (const n of names.sort()) {
      const root = path.join(this.dir, n);
      try {
        const { manifest } = await readPluginManifest(root);
        if (!q || `${manifest.id} ${manifest.name} ${manifest.description ?? ""}`.toLowerCase().includes(q)) out.push(toEntry(manifest, root, this.name));
      } catch {
        /* not a plugin */
      }
    }
    return out;
  }
  async fetch(entry: RegistryEntry, dest: string): Promise<PluginManifest> {
    await copyPluginRuntime(entry.location, dest); // distributed plugins never include sources
    return (await readPluginManifest(dest)).manifest;
  }
}

/**
 * HTTP registry: GET `<baseUrl>/index.json` → `{ plugins: [{ id, name, version, description, author, permissions, url, sha256 }] }`
 * where `url` points at a `.tgz` produced by `fluxplugin package`. Downloads are verified against `sha256` when given.
 */
export class HttpRegistry implements PluginRegistry {
  readonly name: string;
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.name = `http:${baseUrl}`;
  }
  async search(query = ""): Promise<RegistryEntry[]> {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/";
    const res = await this.fetchImpl(new URL("index.json", base));
    if (!res.ok) throw new Error(`store responded ${res.status}`);
    return entriesFromIndex((await res.json()) as StoreIndex, base, this.name, query);
  }
  async fetch(entry: RegistryEntry, dest: string): Promise<PluginManifest> {
    const res = await this.fetchImpl(entry.location);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (entry.sha256 && crypto.createHash("sha256").update(buf).digest("hex") !== entry.sha256.replace(/^sha256-/, "")) {
      throw new Error("downloaded archive does not match the registry checksum");
    }
    await extractTarGz(buf, dest);
    return (await readPluginManifest(dest)).manifest;
  }
}

export interface InstallResult {
  id: string;
  version: string;
  previousVersion?: string;
}

/**
 * Installs plugins into a directory, keeping the previous version as a backup so `rollback` works.
 * Layout: `<pluginsDir>/<id>/` (active) and `<backupDir>/<id>/<version>/` (previous versions).
 */
export class PluginInstaller {
  constructor(
    private readonly pluginsDir: string,
    private readonly backupDir: string,
    private readonly registries: PluginRegistry[] = [],
  ) {}

  addRegistry(r: PluginRegistry): void {
    this.registries.push(r);
  }

  async search(query?: string): Promise<RegistryEntry[]> {
    const all = await Promise.allSettled(this.registries.map((r) => r.search(query)));
    return all.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async installed(): Promise<PluginManifest[]> {
    const out: PluginManifest[] = [];
    for (const n of await fs.readdir(this.pluginsDir).catch(() => [])) {
      try {
        out.push((await readPluginManifest(path.join(this.pluginsDir, n))).manifest);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  private dirOf(id: string): string {
    return path.join(this.pluginsDir, id.replace(/[^a-z0-9.-]/gi, "_"));
  }

  /** Installs (or updates) `entry`. The plugin directory is replaced atomically from a staging directory. */
  async install(entry: RegistryEntry): Promise<InstallResult> {
    const registry = this.registries.find((r) => r.name === entry.source);
    if (!registry) throw new Error(`unknown registry "${entry.source}"`);
    const stage = path.join(this.backupDir, ".staging", `${entry.id}-${Date.now()}`);
    await fs.mkdir(path.dirname(stage), { recursive: true });
    try {
      const manifest = await registry.fetch(entry, stage);
      await pruneNonRuntime(stage); // a store package never installs sources or sourcemaps, whatever it contains
      if (manifest.id !== entry.id) throw new Error(`registry entry "${entry.id}" contains plugin "${manifest.id}"`);
      const target = this.dirOf(entry.id);
      let previousVersion: string | undefined;
      try {
        previousVersion = (await readPluginManifest(target)).manifest.version;
        const bk = path.join(this.backupDir, entry.id, previousVersion);
        await fs.rm(bk, { recursive: true, force: true });
        await fs.mkdir(path.dirname(bk), { recursive: true });
        await fs.rename(target, bk);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(stage, target);
      return { id: entry.id, version: manifest.version, previousVersion };
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }

  /** Removes the plugin directory (backups are kept so the user can still roll back/reinstall). */
  async uninstall(id: string): Promise<void> {
    const dir = this.dirOf(id);
    const { manifest } = await readPluginManifest(dir);
    const bk = path.join(this.backupDir, id, manifest.version);
    await fs.rm(bk, { recursive: true, force: true });
    await fs.mkdir(path.dirname(bk), { recursive: true });
    await fs.rename(dir, bk);
  }

  async versions(id: string): Promise<string[]> {
    const names = await fs.readdir(path.join(this.backupDir, id)).catch(() => []);
    return names.sort(compareVersions);
  }

  /** Restores the newest backup (or `version`) and keeps the replaced version as a backup. */
  async rollback(id: string, version?: string): Promise<InstallResult> {
    const versions = await this.versions(id);
    const target = version ?? versions[versions.length - 1];
    if (!target || !versions.includes(target)) throw new Error(`no backup available for "${id}"${version ? ` @ ${version}` : ""}`);
    const dir = this.dirOf(id);
    let current: string | undefined;
    try {
      current = (await readPluginManifest(dir)).manifest.version;
      const bk = path.join(this.backupDir, id, current);
      await fs.rm(bk, { recursive: true, force: true });
      await fs.rename(dir, bk);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await fs.rename(path.join(this.backupDir, id, target), dir);
    return { id, version: target, previousVersion: current };
  }

  /** Entries from registries that are newer than what is installed. */
  async updates(): Promise<RegistryEntry[]> {
    const installed = new Map((await this.installed()).map((m) => [m.id, m.version]));
    return (await this.search()).filter((e) => installed.has(e.id) && compareVersions(e.version, installed.get(e.id)!) > 0);
  }
}

export { createTarGz };
