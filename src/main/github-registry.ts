import crypto from "node:crypto";
import { extractTarGz } from "./tar.js";
import { entriesFromIndex, readPluginManifest, type PluginRegistry, type RegistryEntry, type StoreIndex } from "./registry.js";
import type { PluginManifest } from "../core/index.js";

export const DEFAULT_TOPIC = "fluxplugin-plugin";
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;

export interface GitHubRegistryOptions {
  /** Curated catalog: a repository holding `index.json` (see `fluxplugin store add`), e.g. "acme/plugin-store". */
  repo?: string;
  ref?: string;
  indexPath?: string;
  /** Decentralized discovery: every public repo with this topic and a release containing a `.fluxplugin.json` descriptor. */
  topic?: string;
  /** Lifts GitHub's anonymous rate limit (60 req/h). Only ever sent to GitHub hosts. */
  token?: string;
  name?: string;
  apiBase?: string;
  rawBase?: string;
  fetchImpl?: typeof fetch;
}

export interface PluginDescriptor {
  id: string;
  name?: string;
  version: string;
  description?: string;
  author?: string;
  permissions?: string[];
  file: string;
  sha256: string;
  icon?: string;
}

const isLoopback = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "[::1]";

function assertSafeUrl(u: string): URL {
  const url = new URL(u);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) throw new Error(`refusing non-https URL: ${u}`);
  return url;
}

/**
 * GitHub as a plugin store. Two modes (they can be combined by adding two registries):
 *  - `topic` (default): developers publish a GitHub *release* in their own repo with `fluxplugin publish`; it is discovered
 *    through the repository topic. No central approval.
 *  - `repo`: a curated catalog repository with an `index.json`.
 */
export class GitHubRegistry implements PluginRegistry {
  readonly name: string;
  private cache = new Map<string, { at: number; entries: RegistryEntry[] }>();
  constructor(private readonly o: GitHubRegistryOptions = {}) {
    this.name = o.name ?? (o.repo ? `github:${o.repo}` : `github:topic/${o.topic ?? DEFAULT_TOPIC}`);
  }

  private get api(): string {
    return (this.o.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  }
  private get raw(): string {
    return (this.o.rawBase ?? "https://raw.githubusercontent.com").replace(/\/$/, "");
  }
  private trusted(url: URL): boolean {
    const hosts = new Set(["api.github.com", "github.com", "raw.githubusercontent.com", new URL(this.api).hostname, new URL(this.raw).hostname]);
    return hosts.has(url.hostname);
  }
  private async get(u: string, accept = "application/vnd.github+json"): Promise<Response> {
    const url = assertSafeUrl(u);
    const headers: Record<string, string> = { accept, "user-agent": "fluxplugin" };
    if (this.o.token && this.trusted(url)) headers["authorization"] = `Bearer ${this.o.token}`;
    const res = await (this.o.fetchImpl ?? fetch)(url, { headers, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (res.status === 403 || res.status === 429) {
      if (res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429) throw new Error("GitHub rate limit reached. Set GITHUB_TOKEN (any token, no scopes needed) to raise it, or retry later.");
    }
    if (!res.ok) throw new Error(`GitHub responded ${res.status} for ${url.pathname}`);
    return res;
  }
  private async json<T>(u: string): Promise<T> {
    return (await (await this.get(u)).json()) as T;
  }

  async search(query = ""): Promise<RegistryEntry[]> {
    const hit = this.cache.get(query);
    if (hit && Date.now() - hit.at < 60_000) return hit.entries;
    const entries = this.o.repo ? await this.catalog(query) : await this.discover(query);
    this.cache.set(query, { at: Date.now(), entries });
    return entries;
  }

  private async catalog(query: string): Promise<RegistryEntry[]> {
    const ref = this.o.ref ?? "HEAD";
    const base = `${this.raw}/${this.o.repo}/${ref}/`;
    const index = await this.json<StoreIndex>(new URL(this.o.indexPath ?? "index.json", base).href);
    return entriesFromIndex(index, base, this.name, query);
  }

  private async discover(query: string): Promise<RegistryEntry[]> {
    const q = `topic:${this.o.topic ?? DEFAULT_TOPIC}${query ? ` ${query} in:name,description,readme` : ""}`;
    const found = await this.json<{ items?: { full_name: string; html_url: string; stargazers_count?: number }[] }>(`${this.api}/search/repositories?q=${encodeURIComponent(q)}&per_page=30&sort=updated`);
    const out: RegistryEntry[] = [];
    const queue = [...(found.items ?? [])];
    const worker = async (): Promise<void> => {
      for (let repo = queue.shift(); repo; repo = queue.shift()) {
        try {
          const rel = await this.json<{ assets?: { name: string; browser_download_url: string }[] }>(`${this.api}/repos/${repo.full_name}/releases/latest`);
          const descAsset = rel.assets?.find((a) => a.name.endsWith(".fluxplugin.json"));
          if (!descAsset) continue;
          const d = (await (await this.get(descAsset.browser_download_url, "application/json")).json()) as PluginDescriptor;
          const pkg = rel.assets?.find((a) => a.name === d.file);
          if (!d || typeof d.id !== "string" || typeof d.version !== "string" || !pkg || !/^[0-9a-f]{64}$/.test(d.sha256 ?? "")) continue;
          out.push({ id: d.id, name: d.name ?? d.id, version: d.version, description: d.description, author: d.author, permissions: d.permissions ?? [], location: pkg.browser_download_url, source: this.name, sha256: d.sha256, homepage: repo.html_url, stars: repo.stargazers_count });
        } catch (e) {
          if (/rate limit/i.test((e as Error).message)) throw e; // surface it; other repos failing individually is normal
        }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    return out.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.id.localeCompare(b.id));
  }

  async fetch(entry: RegistryEntry, dest: string): Promise<PluginManifest> {
    const res = await this.get(entry.location, "application/octet-stream");
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_PACKAGE_BYTES) throw new Error("package is too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PACKAGE_BYTES) throw new Error("package is too large");
    if (!entry.sha256) throw new Error("this store entry has no checksum; refusing to install an unverifiable package");
    if (crypto.createHash("sha256").update(buf).digest("hex") !== entry.sha256.replace(/^sha256-/, "")) throw new Error("downloaded package does not match the published checksum");
    await extractTarGz(buf, dest);
    return (await readPluginManifest(dest)).manifest;
  }
}
