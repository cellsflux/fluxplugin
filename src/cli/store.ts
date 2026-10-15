import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { validateManifest } from "../core/index.js";
import { copyPluginRuntime, readTarGz, type StoreIndex } from "../main/index.js";

const INDEX = "index.json";

export async function storeInit(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const idx = path.join(dir, INDEX);
  if (await fs.stat(idx).catch(() => null)) throw new Error(`${idx} already exists`);
  await fs.writeFile(idx, JSON.stringify({ plugins: [] } satisfies StoreIndex, null, 2));
  await fs.writeFile(path.join(dir, "README.md"), `# My plugin store

A store is a folder with \`index.json\` and the plugin packages (\`.tgz\`).

\`\`\`bash
fluxplugin package ./my-plugin --out .          # build a package
fluxplugin store add com.acme.my-plugin-1.0.0.tgz --dir . --base-url https://plugins.acme.com/
\`\`\`

Host this folder anywhere that serves static files:
- **GitHub Pages** (or a repo's raw files): add \`{ "type": "github", "repo": "acme/plugin-store" }\` to your app's stores
- **Any web server / S3 / CDN**: add \`{ "type": "http", "url": "https://plugins.acme.com/" }\`
- **A shared folder**: \`{ "type": "local", "path": "./my-store" }\`
`);
}

/** Adds (or updates) a package in the store folder and rewrites index.json. */
export async function storeAdd(pkgFile: string, dir: string, baseUrl?: string): Promise<{ id: string; version: string; sha256: string }> {
  const buf = await fs.readFile(pkgFile);
  const entries = await readTarGz(buf);
  const pj = entries.find((e) => e.type === "file" && /^[^/]+\/plugin\.json$/.test(e.name));
  if (!pj) throw new Error("not a fluxplugin package (no plugin.json)");
  const v = validateManifest(JSON.parse(pj.data.toString("utf8")));
  if (!v.manifest) throw new Error("invalid plugin.json in the package: " + v.issues.map((i) => i.message).join("; "));
  const bad = entries.filter((e) => e.type === "file" && /\.(map|tsx?)$/i.test(e.name));
  if (bad.length) throw new Error(`the package contains sources/sourcemaps (${bad[0]!.name}); rebuild it with "fluxplugin package"`);
  const m = v.manifest;
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  await fs.mkdir(dir, { recursive: true });
  const fileName = path.basename(pkgFile);
  if (path.resolve(pkgFile) !== path.resolve(dir, fileName)) await fs.copyFile(pkgFile, path.join(dir, fileName));
  const idxFile = path.join(dir, INDEX);
  const idx: StoreIndex = JSON.parse(await fs.readFile(idxFile, "utf8").catch(() => '{"plugins":[]}'));
  const url = baseUrl ? new URL(fileName, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/").href : fileName;
  const entry = { id: m.id, name: m.name, version: m.version, description: m.description, author: typeof m.author === "string" ? m.author : m.author?.name, permissions: m.permissions ?? [], url, sha256, homepage: m.homepage };
  idx.plugins = [...idx.plugins.filter((p) => !(p.id === m.id && p.version === m.version)), entry].sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version, undefined, { numeric: true }));
  await fs.writeFile(idxFile, JSON.stringify(idx, null, 2));
  return { id: m.id, version: m.version, sha256 };
}

/**
 * Builds the catalog JSON from a repository of plugin folders (`<dir>/plugins/<name>/plugin.json` + built `dist/`).
 * One JSON holds every plugin's metadata (icon, screenshots, video, README…), the exact list of runtime files to download
 * (sources and sourcemaps are never listed) and the sha256 of each file. Commit it next to the folders.
 */
export async function storeBuild(dir: string, opts: { out?: string; pluginsDir?: string; log?: (m: string) => void } = {}): Promise<{ count: number; file: string }> {
  const log = opts.log ?? console.log;
  const root = path.resolve(dir);
  const pluginsRel = opts.pluginsDir ?? ((await fs.stat(path.join(root, "plugins")).catch(() => null)) ? "plugins" : ".");
  const base = path.join(root, pluginsRel);
  const out = path.resolve(opts.out ?? path.join(root, INDEX));
  const plugins: StoreIndex["plugins"] = [];
  const tmpRoot = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "flux-store-"));
  try {
    for (const name of (await fs.readdir(base)).sort()) {
      const folder = path.join(base, name);
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(await fs.readFile(path.join(folder, "plugin.json"), "utf8"));
      } catch {
        continue;
      }
      const v = validateManifest(raw);
      if (!v.manifest) {
        log(`! skipped ${name}: ${v.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
        continue;
      }
      const m = v.manifest;
      const stage = path.join(tmpRoot, name);
      const files = (await copyPluginRuntime(folder, stage)).sort();
      const hashes: Record<string, string> = {};
      for (const f of files) hashes[f] = crypto.createHash("sha256").update(await fs.readFile(path.join(stage, f))).digest("hex");
      const rel = (p: string | undefined) => (p ? p.replace(/^\.\//, "") : undefined);
      const relFolder = (path.relative(root, folder).split(path.sep).join("/")) + "/";
      const readme = await fs.readFile(path.join(folder, rel(m.readme) ?? "README.md"), "utf8").then((s) => s.slice(0, 20_000), () => undefined);
      plugins.push({
        id: m.id, name: m.name, version: m.version, description: m.description, author: typeof m.author === "string" ? m.author : m.author?.name,
        permissions: m.permissions ?? [], folder: relFolder, files, hashes, homepage: m.homepage, license: m.license,
        icon: m.icon ? relFolder + rel(m.icon) : undefined, banner: m.banner ? relFolder + rel(m.banner) : undefined,
        screenshots: (m.screenshots ?? []).map((s) => relFolder + rel(s)),
        video: m.video?.startsWith("./") ? relFolder + rel(m.video) : m.video,
        categories: m.categories, keywords: m.keywords, links: m.links, readme,
      });
      log(`  ${m.id}@${m.version}  (${files.length} files)`);
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
  await fs.writeFile(out, JSON.stringify({ plugins }, null, 2));
  return { count: plugins.length, file: out };
}
