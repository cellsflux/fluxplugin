import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateManifest, type PluginManifest } from "../core/index.js";
import { computeIntegrity, copyPluginRuntime, createTarGz, signManifest, type PluginDescriptor } from "../main/index.js";
import { buildPlugin } from "./build.js";

export interface PackageResult {
  file: string;
  descriptorFile: string;
  sha256: string;
  manifest: PluginManifest;
  shipped: string[];
  signed: boolean;
}

/**
 * Builds the plugin (no sourcemaps) and writes `<id>-<version>.tgz` + `<id>-<version>.fluxplugin.json` (the descriptor stores
 * read to list the plugin without downloading it). Only runtime files are packaged: plugin.json, dist/, assets/, README/LICENSE.
 */
export async function packagePlugin(root: string, opts: { out?: string; signKey?: string; log?: (m: string) => void } = {}): Promise<PackageResult> {
  const log = opts.log ?? console.log;
  await buildPlugin(root, false, log);
  let raw = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8")) as Record<string, unknown>;
  const v = validateManifest(raw);
  if (!v.manifest) throw new Error("invalid plugin.json: " + v.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  const m = v.manifest;
  raw["integrity"] = await computeIntegrity(root, m);
  if (opts.signKey) raw = signManifest(raw, (await fs.readFile(opts.signKey, "utf8")).trim());
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "flux-pack-"));
  try {
    const shipped = await copyPluginRuntime(root, stage);
    await fs.writeFile(path.join(stage, "plugin.json"), JSON.stringify(raw, null, 2));
    const bad = shipped.filter((f) => /\.(map|tsx?)$/i.test(f) || f.startsWith("src/"));
    if (bad.length) throw new Error(`refusing to package sources/sourcemaps: ${bad.join(", ")}`);
    const buf = await createTarGz(stage);
    const out = path.resolve(opts.out ?? ".");
    await fs.mkdir(out, { recursive: true });
    const file = path.join(out, `${m.id}-${m.version}.tgz`);
    await fs.writeFile(file, buf);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const descriptor: PluginDescriptor = {
      id: m.id, name: m.name, version: m.version, description: m.description,
      author: typeof m.author === "string" ? m.author : m.author?.name, permissions: m.permissions ?? [], file: path.basename(file), sha256,
    };
    const descriptorFile = path.join(out, `${m.id}-${m.version}.fluxplugin.json`);
    await fs.writeFile(descriptorFile, JSON.stringify(descriptor, null, 2));
    log(`packaged ${path.relative(process.cwd(), file) || file}  (${shipped.length} files: ${shipped.filter((x) => x !== "plugin.json").slice(0, 6).join(", ")}${shipped.length > 7 ? ", …" : ""})\n  sha256 ${sha256}${opts.signKey ? "\n  signed" : ""}`);
    return { file, descriptorFile, sha256, manifest: m, shipped, signed: !!opts.signKey };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
