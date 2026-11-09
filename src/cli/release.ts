import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffSnapshots, nextVersion, type ReleaseEntry, type UpdateManifest } from "../core/index.js";
import { copyPluginRuntime, signUpdateManifest } from "../main/index.js";
import { loadConfig } from "./config.js";
import { buildHost } from "./host.js";
import { renderChanges } from "./release-notes.js";

export interface ProductionOptions {
  bump?: "patch" | "minor" | "major" | "none";
  /** Folder that becomes your update server (static host). Default: release-server */
  out?: string;
  /** URL where `out` will be served (default: relative URLs). */
  baseUrl?: string;
  /** owner/repo: also create the GitHub release and upload the files. */
  github?: string;
  token?: string;
  apiBase?: string;
  /** Base64 PKCS#8 private key (or env FLUXPLUGIN_UPDATE_KEY) used to sign latest.json. */
  signKey?: string;
  /** Oldest installed application that can load this update. */
  minHost?: string;
  dryRun?: boolean;
  log?: (m: string) => void;
  fetchImpl?: typeof fetch;
}

const START = "<!-- auto:start -->";
const END = "<!-- auto:end -->";
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

async function listFiles(root: string, skip: (rel: string) => boolean = () => false): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip(r)) continue;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) out[r] = await fs.readFile(path.join(root, r));
    }
  };
  await walk("");
  return out;
}

/**
 * `fluxplugin publish --production`: bumps the version, builds the app, writes what your update server needs
 * (latest.json, releases.json, notes, content-addressed blobs — only NEW files) and, with `github`, publishes it as a release.
 * Installed apps then download only the files that changed.
 */
export async function publishProduction(cwd: string, o: ProductionOptions = {}): Promise<{ version: string; files: number; newFiles: number; newBytes: number; reusedBytes: number; out: string }> {
  const log = o.log ?? console.log;
  const pkgFile = path.join(cwd, "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgFile, "utf8")) as { version: string; name?: string };
  const bump = o.bump ?? "patch";
  const version = bump === "none" ? pkg.version : nextVersion(pkg.version, bump);
  log(`version ${pkg.version} → ${version}`);

  await buildHost(cwd, { log });
  const cfg = await loadConfig({}, cwd);
  const payload: Record<string, Buffer> = await listFiles(path.join(cwd, "dist"), (r) => r === "boot.cjs" || r.endsWith(".map"));
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "flux-release-"));
  try {
    for (const d of await fs.readdir(cfg.pluginsDir).catch(() => [])) {
      if (!(await fs.stat(path.join(cfg.pluginsDir, d, "plugin.json")).catch(() => null))) continue;
      await copyPluginRuntime(path.join(cfg.pluginsDir, d), path.join(stage, d));
      for (const [r, b] of Object.entries(await listFiles(path.join(stage, d)))) payload[`plugins/${d}/${r}`] = b;
    }
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
  const hashes = Object.fromEntries(Object.entries(payload).map(([p, b]) => [p, sha(b)]));

  // release notes: the developer's text is kept; the detected changes live in the auto block
  const relDir = path.join(cwd, "releases");
  await fs.mkdir(relDir, { recursive: true });
  const snapFile = path.join(relDir, ".snapshot.json");
  const prev = JSON.parse(await fs.readFile(snapFile, "utf8").catch(() => "null")) as { version: string; files: Record<string, string> } | null;
  const diff = prev ? diffSnapshots({ files: prev.files, permissions: [], dependencies: {} } as never, { files: hashes, permissions: [], dependencies: {} } as never) : undefined;
  const auto = `${START}\n## Detected changes\n\n${renderChanges(diff, prev?.version)}${END}`;
  const notesFile = path.join(relDir, `${version}.md`);
  const existing = await fs.readFile(notesFile, "utf8").catch(() => undefined);
  const notes = existing === undefined
    ? `# ${pkg.name ?? "App"} ${version}\n\n<!-- Write what is new for users: features, fixes, breaking changes, what to do after updating. -->\n\n${auto}\n`
    : existing.includes(START) && existing.includes(END) ? existing.slice(0, existing.indexOf(START)) + auto + existing.slice(existing.indexOf(END) + END.length) : `${existing.trimEnd()}\n\n${auto}\n`;
  await fs.writeFile(notesFile, notes);

  // update server layout
  const out = path.resolve(cwd, o.out ?? "release-server");
  await fs.mkdir(path.join(out, "blobs"), { recursive: true });
  const old = JSON.parse(await fs.readFile(path.join(out, "latest.json"), "utf8").catch(() => "null")) as UpdateManifest | null;
  const known = new Map<string, string>();
  for (const f of Object.values(old?.files ?? {})) known.set(f.sha256, f.url);
  const base = o.github ? `https://github.com/${o.github}/releases/download/v${version}/` : o.baseUrl ?? "";
  const files: UpdateManifest["files"] = {};
  const fresh: { sha: string; buf: Buffer }[] = [];
  let reusedBytes = 0;
  for (const [p, buf] of Object.entries(payload)) {
    const h = hashes[p]!;
    const url = known.get(h) ?? (o.github ? `${base}blob-${h}` : `${base}blobs/${h}`);
    if (!known.has(h) && !fresh.some((x) => x.sha === h)) fresh.push({ sha: h, buf });
    else reusedBytes += buf.length;
    files[p] = { sha256: h, size: buf.length, url };
  }
  const key = o.signKey ?? process.env["FLUXPLUGIN_UPDATE_KEY"];
  const unsigned: UpdateManifest = { version, publishedAt: new Date().toISOString(), notes, minHost: o.minHost, files };
  const manifest = key ? signUpdateManifest(unsigned, key) : unsigned;
  if (!key) log("! latest.json is NOT signed: set FLUXPLUGIN_UPDATE_KEY (or --sign-key) so apps can reject forged updates.");

  // installers built by `fluxplugin dist`, so any version can be downloaded in full
  const installers: Record<string, string> = {};
  const installerFiles: { name: string; file: string }[] = [];
  for (const n of await fs.readdir(path.join(cwd, "release")).catch(() => [])) {
    const plat = /\.exe$/i.test(n) ? "win" : /\.dmg$/i.test(n) ? "mac" : /\.(AppImage|deb)$/i.test(n) ? "linux" : undefined;
    if (!plat) continue;
    installers[plat] = o.github ? `${base}${n}` : `${base}installers/${version}/${n}`;
    installerFiles.push({ name: n, file: path.join(cwd, "release", n) });
  }
  const oldReleases = JSON.parse(await fs.readFile(path.join(out, "releases.json"), "utf8").catch(() => "[]")) as ReleaseEntry[];
  const releases: ReleaseEntry[] = [{ version, publishedAt: manifest.publishedAt, notes, installers: Object.keys(installers).length ? installers : undefined }, ...oldReleases.filter((r) => r.version !== version)];

  const summary = { version, files: Object.keys(files).length, newFiles: fresh.length, newBytes: fresh.reduce((n, f) => n + f.buf.length, 0), reusedBytes, out };
  if (o.dryRun) {
    log(`[dry run] ${summary.newFiles} new file(s) (${summary.newBytes} bytes) would be published; ${summary.files - summary.newFiles} unchanged.`);
    return summary;
  }
  for (const f of fresh) await fs.writeFile(path.join(out, "blobs", f.sha), f.buf);
  for (const i of installerFiles) {
    await fs.mkdir(path.join(out, "installers", version), { recursive: true });
    await fs.copyFile(i.file, path.join(out, "installers", version, i.name));
  }
  await fs.mkdir(path.join(out, "notes"), { recursive: true });
  await fs.writeFile(path.join(out, "notes", `${version}.md`), notes);
  await fs.writeFile(path.join(out, "latest.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(out, "releases.json"), JSON.stringify(releases, null, 2));
  await fs.writeFile(pkgFile, JSON.stringify({ ...pkg, version }, null, 2) + "\n");
  await fs.writeFile(snapFile, JSON.stringify({ version, files: hashes }));

  if (o.github) {
    const token = o.token ?? process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
    if (!token) throw new Error("no GitHub token: set GITHUB_TOKEN (or pass --token)");
    const api = (o.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    const f = o.fetchImpl ?? fetch;
    const gh = async (method: string, url: string, body?: unknown, type?: string, raw?: Uint8Array) => {
      const r = await f(url, { method, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "fluxplugin", ...(body ? { "content-type": "application/json" } : type ? { "content-type": type } : {}) }, body: (raw ?? (body ? JSON.stringify(body) : undefined)) as BodyInit | undefined });
      return { status: r.status, json: await r.json().catch(() => null) } as { status: number; json: any };
    };
    const rel = await gh("POST", `${api}/repos/${o.github}/releases`, { tag_name: `v${version}`, name: `${pkg.name ?? "App"} ${version}`, body: notes, draft: false });
    if (rel.status === 422) throw new Error(`release v${version} already exists: bump the version`);
    if (rel.status >= 300) throw new Error(`could not create the release (${rel.status}): ${rel.json?.message ?? ""}`);
    const upload = String(rel.json.upload_url).replace(/\{\?[^}]*\}$/, "");
    const assets: { name: string; data: Uint8Array; type: string }[] = [
      { name: "latest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)), type: "application/json" },
      { name: "releases.json", data: Buffer.from(JSON.stringify(releases, null, 2)), type: "application/json" },
      { name: `notes-${version}.md`, data: Buffer.from(notes), type: "text/markdown" },
      ...fresh.map((x) => ({ name: `blob-${x.sha}`, data: x.buf as Uint8Array, type: "application/octet-stream" })),
      ...(await Promise.all(installerFiles.map(async (i) => ({ name: i.name, data: new Uint8Array(await fs.readFile(i.file)), type: "application/octet-stream" })))),
    ];
    for (const a of assets) {
      const r = await gh("POST", `${upload}?name=${encodeURIComponent(a.name)}`, undefined, a.type, a.data);
      if (r.status >= 300) throw new Error(`upload of ${a.name} failed (${r.status})`);
    }
    log(`✔ GitHub release v${version}: ${assets.length} assets. Point your app at { "type": "github", "repo": "${o.github}" }.`);
  }
  log(`✔ ${version}: ${summary.newFiles} new file(s) (${(summary.newBytes / 1024).toFixed(1)} KB) — installed apps download only these; ${summary.files - summary.newFiles} unchanged file(s) are reused.\n  update server folder: ${out}\n  release notes: releases/${version}.md (edit it, then publish again to refresh)`);
  return summary;
}
