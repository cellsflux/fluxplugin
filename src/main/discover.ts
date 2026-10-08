import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginDefinition, PluginManifest, PluginSource } from "../core/index.js";
import { validateManifest } from "../core/index.js";
import { IntegrityError, verifyPlugin, type VerifyOptions } from "./security.js";

export const MANIFEST_FILE = "plugin.json";

export interface DiscoveredPlugin {
  root: string;
  manifest: Record<string, unknown>;
  source: PluginSource;
  /** Errors found while reading the plugin (it is still returned so the UI can display the failure). */
  problem?: string;
}

let counter = 0;

/** Imports an ESM/CJS entry and returns its default export. A unique query string defeats the module cache (hot reload). */
export async function importFresh(file: string): Promise<unknown> {
  const url = pathToFileURL(file).href + `?flux=${Date.now()}.${counter++}`;
  const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown } & Record<string, unknown>;
  return mod.default ?? mod;
}

function toDefinition(x: unknown, entry: string): PluginDefinition<any> {
  const def = (x && typeof x === "object" && "default" in (x as object) ? (x as { default: unknown }).default : x) as PluginDefinition<any> | undefined;
  if (!def || typeof def !== "object") throw new Error(`"${entry}" must default-export definePlugin({...})`);
  return def;
}

export interface DiscoverOptions extends VerifyOptions {
  /** Entry loader override (tests, bundlers). */
  loadEntry?: (file: string) => Promise<unknown>;
}

/** Reads one plugin directory. */
export async function readPluginDir(root: string, opts: DiscoverOptions = {}): Promise<DiscoveredPlugin> {
  const abs = path.resolve(root);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(path.join(abs, MANIFEST_FILE), "utf8"));
  } catch (e) {
    raw = { id: `invalid.${path.basename(abs)}`.toLowerCase().replace(/[^a-z0-9.-]/g, "-") };
    return {
      root: abs,
      manifest: raw,
      problem: `cannot read ${MANIFEST_FILE}: ${(e as Error).message}`,
      source: { manifest: raw, root: abs, origin: `dir:${abs}`, load: async () => ({}) },
    };
  }
  let problem: string | undefined;
  const v = validateManifest(raw);
  if (v.manifest) {
    try {
      await verifyPlugin(abs, raw, v.manifest, opts);
    } catch (e) {
      problem = e instanceof IntegrityError ? e.message : `verification failed: ${(e as Error).message}`;
    }
  }
  const mainRel = v.manifest?.main;
  const load = opts.loadEntry ?? importFresh;
  const source: PluginSource = {
    manifest: raw,
    root: abs,
    origin: `dir:${abs}`,
    load: async () => {
      if (problem) throw new IntegrityError(problem);
      if (!mainRel) return {};
      const file = path.resolve(abs, mainRel);
      if (!file.startsWith(abs + path.sep)) throw new IntegrityError(`main entry escapes plugin directory`);
      return toDefinition(await load(file), mainRel);
    },
  };
  return { root: abs, manifest: raw, source, problem };
}

/** Scans `dir` for sub-directories containing a plugin.json. Plugins that fail verification are reported, not skipped. */
export async function discoverPlugins(dir: string, opts: DiscoverOptions = {}): Promise<DiscoveredPlugin[]> {
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: DiscoveredPlugin[] = [];
  for (const name of entries.sort()) {
    const root = path.join(dir, name);
    try {
      await fs.access(path.join(root, MANIFEST_FILE));
    } catch {
      continue;
    }
    out.push(await readPluginDir(root, opts));
  }
  return out;
}

export type { PluginManifest };
