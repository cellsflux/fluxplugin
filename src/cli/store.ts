import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { validateManifest } from "../core/index.js";
import { readTarGz, type StoreIndex } from "../main/index.js";

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
