import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { analyzeUpdate, compareVersions, dedupeEntries, filterEntries, planInstall, validateManifest, type CatalogConflict, type InstallPlan, type InstalledSnapshot, type PluginManifest, type RegistryEntryLike, type UpdateAnalysis } from "../core/index.js";
import { MANIFEST_FILE } from "./discover.js";
import { createTarGz, extractTarGz } from "./tar.js";

/** One plugin listed by a store — the same type the UI and the catalog logic use (no parallel definition). */
export type RegistryEntry = RegistryEntryLike;

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
  dependencies: { ...m.dependencies, ...m.peerDependencies },
  provides: m.provides,
  conflicts: m.conflicts,
  pricing: m.pricing,
  categories: m.categories,
  keywords: m.keywords,
  license: m.license,
  location,
  source,
  sha256,
});

const RUNTIME_DIRS = new Set(["dist", "assets", "images", "docs", "updates"]);
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
      } else if (e.isFile() && !e.name.startsWith(".")) {
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

/** Shape of a store catalog: `{ "plugins": [...] }` or a bare array. Served as a file, built by `fluxplugin store build`, or returned by any API. */
export interface StoreIndexPlugin {
  id: string;
  name?: string;
  version: string;
  description?: string;
  author?: string;
  permissions?: string[];
  /** A package (.tgz)… */
  url?: string;
  sha256?: string;
  /** …or a plugin folder in the repository / on the host, with its file list and sha256 of every file. */
  folder?: string;
  files?: string[];
  hashes?: Record<string, string>;
  homepage?: string;
  license?: string;
  icon?: string;
  banner?: string;
  screenshots?: string[];
  video?: string;
  categories?: string[];
  keywords?: string[];
  links?: Record<string, string>;
  /** Markdown, inline (keep it short) */
  readme?: string;
  dependencies?: Record<string, string>;
  provides?: string[];
  conflicts?: string[];
  pricing?: RegistryEntryLike["pricing"];
  updatedAt?: string;
  /** Release notes (updates/<version>.md), newest first. */
  updates?: { version: string; notes: string }[];
}
export interface StoreIndex {
  plugins: StoreIndexPlugin[];
}

export function entriesFromIndex(index: StoreIndex | StoreIndexPlugin[], baseUrl: string, source: string, query = ""): RegistryEntry[] {
  const list = Array.isArray(index) ? index : (index?.plugins ?? []);
  const q = query.toLowerCase();
  const abs = (u: string | undefined): string | undefined => {
    if (!u) return undefined;
    try {
      return new URL(u, baseUrl).href;
    } catch {
      return undefined;
    }
  };
  const out: RegistryEntry[] = [];
  for (const p of list) {
    if (!p || typeof p.id !== "string" || typeof p.version !== "string") continue;
    const isFolder = typeof p.folder === "string" && Array.isArray(p.files);
    if (typeof p.url !== "string" && !isFolder) continue;
    if (q && !`${p.id} ${p.name ?? ""} ${p.description ?? ""} ${(p.keywords ?? []).join(" ")}`.toLowerCase().includes(q)) continue;
    const folderUrl = isFolder ? (abs(p.folder!.endsWith("/") ? p.folder! : p.folder! + "/") as string) : undefined;
    const location = isFolder ? folderUrl : abs(p.url!);
    if (!location) continue;
    out.push({
      id: p.id, name: p.name ?? p.id, version: p.version, description: p.description, author: p.author, permissions: p.permissions ?? [],
      location, source, sha256: p.sha256, homepage: p.homepage, license: p.license,
      iconUrl: abs(p.icon), bannerUrl: abs(p.banner), screenshots: (p.screenshots ?? []).map((s) => abs(s)).filter((s): s is string => !!s),
      video: p.video ? (p.video.startsWith("./") && folderUrl ? abs(new URL(p.video, folderUrl).href) : abs(p.video)) : undefined,
      categories: p.categories, keywords: p.keywords, links: p.links, readme: p.readme,
      folder: isFolder || undefined, files: isFolder ? p.files : undefined, hashes: p.hashes,
      dependencies: p.dependencies, provides: p.provides, conflicts: p.conflicts, pricing: p.pricing, updatedAt: p.updatedAt, updates: p.updates,
    });
  }
  return out;
}

const SAFE_FILE = /^[\w@+.,() \-]+(\/[\w@+.,() \-]+)*$/;

/** Downloads a plugin folder file by file, verifying every file against the catalog's sha256 (required). */
export async function downloadFolder(entry: RegistryEntry, dest: string, get: (url: string) => Promise<Response>): Promise<void> {
  const base = entry.location.endsWith("/") ? entry.location : entry.location + "/";
  const files = entry.files ?? [];
  if (!files.includes("plugin.json")) throw new Error("catalog entry does not list plugin.json");
  if (files.length > 800) throw new Error("catalog entry lists too many files");
  if (!entry.hashes) throw new Error("catalog entry has no file hashes; refusing to install an unverifiable folder (run `fluxplugin store build`)");
  const root = path.resolve(dest);
  await fs.mkdir(root, { recursive: true });
  let total = 0;
  const queue = [...files];
  const worker = async (): Promise<void> => {
    for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
      if (!SAFE_FILE.test(f) || f.split("/").some((s) => s === ".." || s === ".")) throw new Error(`unsafe file path in catalog: ${f}`);
      const expected = entry.hashes![f];
      if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`no sha256 for ${f} in the catalog`);
      const res = await get(base + f.split("/").map(encodeURIComponent).join("/"));
      const buf = Buffer.from(await res.arrayBuffer());
      total += buf.length;
      if (total > 100 * 1024 * 1024) throw new Error("plugin is too large");
      if (crypto.createHash("sha256").update(buf).digest("hex") !== expected) throw new Error(`${f} does not match the catalog checksum`);
      const target = path.resolve(root, f);
      if (!target.startsWith(root + path.sep)) throw new Error(`unsafe file path in catalog: ${f}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buf);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
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
 * HTTP/JSON store. `url` is either a folder holding `index.json` ("https://plugins.acme.com/") or a direct link to a JSON
 * document / API endpoint that returns the catalog ("https://api.acme.com/plugins" or ".../plugins.json").
 * Entries are packages (`url` → .tgz, checked against `sha256`) or plugin folders (`folder` + `files` + `hashes`).
 */
export class HttpRegistry implements PluginRegistry {
  readonly name: string;
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly headers: Record<string, string> = {},
    private readonly direct = false,
  ) {
    this.name = `http:${baseUrl}`;
  }
  /** Direct link (".json" file, or `direct: true` for an API endpoint) or a folder that contains index.json. */
  private get catalogUrl(): string {
    if (this.direct || new URL(this.baseUrl).pathname.toLowerCase().endsWith(".json")) return this.baseUrl;
    return new URL("index.json", this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/").href;
  }
  private get(url: string): Promise<Response> {
    return this.fetchImpl(url, { headers: { accept: "application/json, application/octet-stream", ...this.headers } }).then((r) => {
      if (!r.ok) throw new Error(`store responded ${r.status} for ${new URL(url).pathname}`);
      return r;
    });
  }
  async search(query = ""): Promise<RegistryEntry[]> {
    const url = this.catalogUrl;
    return entriesFromIndex((await (await this.get(url)).json()) as StoreIndex, url, this.name, query);
  }
  async fetch(entry: RegistryEntry, dest: string): Promise<PluginManifest> {
    if (entry.folder) {
      await downloadFolder(entry, dest, (u) => this.get(u));
      return (await readPluginManifest(dest)).manifest;
    }
    const res = await this.get(entry.location);
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

/** Written next to the plugin's files at install time: lets later checks detect any change (even without a version bump). */
export interface InstallRecord {
  id: string;
  version: string;
  source: string;
  installedAt: string;
  packageSha256?: string;
  files: Record<string, string>;
}
export const INSTALL_RECORD = ".flux-install.json";

export interface CatalogSnapshot {
  /** One entry per plugin id. */
  entries: RegistryEntry[];
  /** Every listing before de-duplication (all versions, all stores). */
  all: RegistryEntry[];
  conflicts: CatalogConflict[];
  errors: { source: string; message: string }[];
  fetchedAt: number;
}

async function hashDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && e.name !== INSTALL_RECORD) out[r] = crypto.createHash("sha256").update(await fs.readFile(path.join(dir, r))).digest("hex");
    }
  };
  await walk("");
  return out;
}

/**
 * Installs plugins into a directory. Everything is prepared (downloaded, verified, pruned) in a staging area first; files are only
 * swapped in when every step succeeded, and any failure restores what was there before — for one plugin or a whole dependency set.
 * Layout: `<pluginsDir>/<id>/` (active) and `<backupDir>/<id>/<version>/` (previous versions). User data and settings live outside
 * the plugin folder (plugins-data), so updates never touch them.
 */
export class PluginInstaller {
  private cache?: { snap: CatalogSnapshot; key: string };
  private inflight?: Promise<CatalogSnapshot>;

  constructor(
    private readonly pluginsDir: string,
    private readonly backupDir: string,
    private readonly registries: PluginRegistry[] = [],
    private readonly cacheMs = 30_000,
  ) {}

  /** Where plugins are installed. */
  get dir(): string {
    return this.pluginsDir;
  }

  addRegistry(r: PluginRegistry): void {
    this.registries.push(r);
    this.cache = undefined;
  }

  /**
   * The catalog of every store, **one entry per plugin id** (see `dedupeEntries`). Concurrent callers share one request, results are
   * cached briefly, and a store that fails is reported in `errors` without hiding the others.
   */
  async catalog(opts: { refresh?: boolean } = {}): Promise<CatalogSnapshot> {
    const key = this.registries.map((r) => r.name).join("|");
    if (!opts.refresh && this.cache?.key === key && Date.now() - this.cache.snap.fetchedAt < this.cacheMs) return this.cache.snap;
    if (this.inflight && !opts.refresh) return this.inflight;
    const run = (async (): Promise<CatalogSnapshot> => {
      const results = await Promise.allSettled(this.registries.map((r) => r.search()));
      const all: RegistryEntry[] = [];
      const errors: CatalogSnapshot["errors"] = [];
      results.forEach((r, i) => (r.status === "fulfilled" ? all.push(...r.value) : errors.push({ source: this.registries[i]!.name, message: (r.reason as Error)?.message ?? String(r.reason) })));
      const { entries, conflicts } = dedupeEntries(all, this.registries.map((r) => r.name)); // first store in the list is the reference
      const snap = { entries, all, conflicts, errors, fetchedAt: Date.now() };
      if (errors.length < this.registries.length || this.registries.length === 0) this.cache = { snap, key };
      return snap;
    })();
    this.inflight = run;
    try {
      return await run;
    } finally {
      this.inflight = undefined;
    }
  }

  /** De-duplicated search (text filter only; paging/categories are applied by `queryCatalog`). */
  async search(query?: string): Promise<RegistryEntry[]> {
    const { entries, errors } = await this.catalog();
    if (errors.length && !entries.length) throw new Error(errors.map((e) => `${e.source}: ${e.message}`).join("; "));
    return query ? filterEntries(entries, { q: query }) : entries;
  }

  async candidates(id: string): Promise<RegistryEntry[]> {
    return (await this.catalog()).all.filter((e) => e.id === id);
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

  /** What is installed in `dir`: manifest facts + a hash of every file (+ the package checksum recorded at install time). */
  async snapshotAt(dir: string): Promise<InstalledSnapshot> {
    const m = (await readPluginManifest(dir)).manifest;
    let record: InstallRecord | undefined;
    try {
      record = JSON.parse(await fs.readFile(path.join(dir, INSTALL_RECORD), "utf8"));
    } catch {
      /* installed by hand / during development */
    }
    return {
      id: m.id, version: m.version, name: m.name, description: m.description, license: m.license, provides: m.provides,
      permissions: m.permissions ?? [], dependencies: { ...m.dependencies, ...m.peerDependencies }, files: await hashDir(dir), packageSha256: record?.packageSha256,
    };
  }

  async analyze(entry: RegistryEntry, dir?: string): Promise<UpdateAnalysis | undefined> {
    try {
      return analyzeUpdate(await this.snapshotAt(dir ?? this.dirOf(entry.id)), entry);
    } catch {
      return undefined;
    }
  }

  /** What would have to be installed for `entry`, given the plugins already present. Nothing is changed. */
  async plan(entry: RegistryEntry, installed: Map<string, { version: string; conflicts?: string[] }>): Promise<InstallPlan> {
    const { all } = await this.catalog();
    return planInstall(entry, { installed, candidates: (id) => all.filter((e) => e.id === id) });
  }

  async install(entry: RegistryEntry): Promise<InstallResult> {
    return (await this.installMany([entry]))[0]!;
  }

  /**
   * Installs several plugins as one unit (dependencies first). Phase 1 downloads and verifies everything into staging; phase 2
   * swaps the folders in. If anything fails, every folder touched is restored: nothing stays half-installed.
   */
  async installMany(entries: RegistryEntry[]): Promise<InstallResult[]> {
    const staged: { entry: RegistryEntry; stage: string; manifest: PluginManifest }[] = [];
    const cleanup = async () => void (await Promise.all(staged.map((s) => fs.rm(s.stage, { recursive: true, force: true }))));
    try {
      for (const entry of entries) {
        const registry = this.registries.find((r) => r.name === entry.source) ?? this.registries.find((r) => (entry.sources ?? []).includes(r.name));
        if (!registry) throw new Error(`unknown registry "${entry.source}"`);
        const stage = path.join(this.backupDir, ".staging", `${entry.id}-${Date.now()}-${staged.length}`);
        await fs.mkdir(path.dirname(stage), { recursive: true });
        staged.push({ entry, stage, manifest: undefined as never });
        const manifest = await registry.fetch(entry, stage);
        await pruneNonRuntime(stage); // a store package never installs sources or sourcemaps, whatever it contains
        if (manifest.id !== entry.id) throw new Error(`registry entry "${entry.id}" contains plugin "${manifest.id}"`);
        if (manifest.version !== entry.version) throw new Error(`"${entry.id}": the package is version ${manifest.version} but the catalog announced ${entry.version}`);
        staged[staged.length - 1]!.manifest = manifest;
      }
    } catch (e) {
      await cleanup(); // nothing was touched yet
      throw e;
    }
    const undo: (() => Promise<void>)[] = [];
    const results: InstallResult[] = [];
    try {
      for (const { entry, stage, manifest } of staged) {
        const target = this.dirOf(entry.id);
        let previousVersion: string | undefined;
        let backup: string | undefined;
        try {
          previousVersion = (await readPluginManifest(target)).manifest.version;
        } catch {
          /* not installed (or unreadable) */
        }
        if (await fs.stat(target).then(() => true, () => false)) {
          backup = path.join(this.backupDir, entry.id, previousVersion ?? `unreadable-${Date.now()}`);
          await fs.rm(backup, { recursive: true, force: true });
          await fs.mkdir(path.dirname(backup), { recursive: true });
          await fs.rename(target, backup);
        }
        undo.push(async () => {
          await fs.rm(target, { recursive: true, force: true });
          if (backup) await fs.rename(backup, target);
        });
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(stage, target);
        const record: InstallRecord = { id: entry.id, version: manifest.version, source: entry.source, installedAt: new Date().toISOString(), packageSha256: entry.sha256, files: await hashDir(target) };
        await fs.writeFile(path.join(target, INSTALL_RECORD), JSON.stringify(record, null, 2));
        results.push({ id: entry.id, version: manifest.version, previousVersion });
      }
      this.cache = undefined;
      return results;
    } catch (e) {
      for (const u of undo.reverse()) await u().catch(() => undefined); // restore every folder we touched
      throw e;
    } finally {
      await cleanup();
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
    this.cache = undefined;
    return { id, version: target, previousVersion: current };
  }

  /** Catalog entries newer than what is installed in this folder (see `analyze` for the details). */
  async updates(): Promise<RegistryEntry[]> {
    const installed = new Map((await this.installed()).map((m) => [m.id, m.version]));
    return (await this.search()).filter((e) => installed.has(e.id) && compareVersions(e.version, installed.get(e.id)!) > 0);
  }
}

export { createTarGz };
