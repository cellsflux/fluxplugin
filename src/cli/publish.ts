import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TOPIC } from "../main/index.js";
import { packagePlugin } from "./package.js";

export interface PublishOptions {
  repo?: string;
  token?: string;
  signKey?: string;
  dryRun?: boolean;
  topic?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

/** "https://github.com/acme/tool.git" | "git@github.com:acme/tool.git" | "acme/tool" → "acme/tool" */
export function parseGitHubRepo(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:|github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(input.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * Publishes a plugin to the default store: builds + packages it, creates a GitHub release `v<version>` in the plugin's
 * repository, uploads the package and its descriptor, and adds the discovery topic. Anyone using the store can then find and
 * install it. Needs a token that can write to the repository (GITHUB_TOKEN / GH_TOKEN / --token).
 */
export async function publishPlugin(root: string, o: PublishOptions = {}): Promise<{ release?: string; repo: string; version: string; id: string }> {
  const log = o.log ?? console.log;
  const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8")) as Record<string, any>;
  const repo = parseGitHubRepo(o.repo) ?? parseGitHubRepo(typeof manifest["repository"] === "string" ? manifest["repository"] : manifest["repository"]?.url);
  if (!repo || /YOUR_NAME/i.test(JSON.stringify(manifest["repository"] ?? ""))) {
    throw new Error('no GitHub repository: set "repository": "https://github.com/<you>/<repo>" in plugin.json (or pass --repo owner/name)');
  }
  const problems: string[] = [];
  if (!manifest["description"]) problems.push("description is missing");
  if (!manifest["icon"]) problems.push('"icon" is missing');
  if (!manifest["license"]) problems.push('"license" is missing');
  if (problems.length) throw new Error("not ready for the store: " + problems.join("; "));
  for (const rec of ["screenshots", "video", "banner"]) if (!manifest[rec] || (Array.isArray(manifest[rec]) && !manifest[rec].length)) log(`  tip: add "${rec}" to plugin.json for a better store page`);

  const out = await fs.mkdtemp(path.join(os.tmpdir(), "flux-publish-"));
  try {
    const pkg = await packagePlugin(root, { out, signKey: o.signKey, log });
    const tag = `v${pkg.manifest.version}`;
    if (o.dryRun) {
      log(`\n[dry run] would create release ${tag} in github.com/${repo} with:\n  - ${path.basename(pkg.file)}\n  - ${path.basename(pkg.descriptorFile)}\n  and add the topic "${o.topic ?? DEFAULT_TOPIC}"`);
      return { repo, version: pkg.manifest.version, id: pkg.manifest.id };
    }
    const token = o.token ?? process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
    if (!token) throw new Error("no GitHub token. Create one at https://github.com/settings/tokens (repo scope, or fine-grained: Contents + Administration read/write) and set GITHUB_TOKEN, or pass --token");
    const api = (o.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    const f = o.fetchImpl ?? fetch;
    const gh = async (method: string, url: string, body?: unknown, extra: Record<string, string> = {}, raw?: Uint8Array): Promise<{ status: number; json: any }> => {
      const res = await f(url, { method, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "fluxplugin", ...(body ? { "content-type": "application/json" } : {}), ...extra }, body: (raw ?? (body ? JSON.stringify(body) : undefined)) as BodyInit | undefined });
      let json: any = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, json };
    };
    const info = await gh("GET", `${api}/repos/${repo}`);
    if (info.status === 404) throw new Error(`repository github.com/${repo} was not found (or your token cannot see it)`);
    if (info.status === 401) throw new Error("GitHub rejected the token (401)");
    if (info.json?.permissions && !info.json.permissions.push) throw new Error(`your token cannot write to ${repo}`);

    const notes = `${pkg.manifest.name} ${pkg.manifest.version}\n\n${pkg.manifest.description ?? ""}\n\nPermissions: ${(pkg.manifest.permissions ?? []).join(", ") || "none"}\n\nInstall: \`fluxplugin install ${pkg.manifest.id}\` or from the Plugins page of any app using the fluxplugin store.`;
    const rel = await gh("POST", `${api}/repos/${repo}/releases`, { tag_name: tag, name: `${pkg.manifest.name} ${pkg.manifest.version}`, body: notes, draft: false, prerelease: /-/.test(pkg.manifest.version) });
    if (rel.status === 422) throw new Error(`version ${pkg.manifest.version} is already published (release ${tag} exists). Bump "version" in plugin.json and publish again.`);
    if (rel.status >= 300) throw new Error(`could not create the release (${rel.status}): ${rel.json?.message ?? "unknown error"}`);
    const upload = String(rel.json.upload_url).replace(/\{\?[^}]*\}$/, "");
    for (const [file, type] of [[pkg.file, "application/gzip"], [pkg.descriptorFile, "application/json"]] as const) {
      const up = await gh("POST", `${upload}?name=${encodeURIComponent(path.basename(file))}`, undefined, { "content-type": type }, new Uint8Array(await fs.readFile(file)));
      if (up.status >= 300) throw new Error(`upload of ${path.basename(file)} failed (${up.status}): ${up.json?.message ?? ""}`);
    }
    const topics = await gh("GET", `${api}/repos/${repo}/topics`);
    const names: string[] = topics.json?.names ?? [];
    const topic = o.topic ?? DEFAULT_TOPIC;
    if (!names.includes(topic)) {
      const put = await gh("PUT", `${api}/repos/${repo}/topics`, { names: [...names, topic] });
      if (put.status >= 300) log(`  ! could not add the topic "${topic}" (${put.status}): add it yourself in the repository settings (About → Topics) so the store can find your plugin.`);
    }
    log(`\n✔ published ${pkg.manifest.id}@${pkg.manifest.version}\n  release: ${rel.json.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`}\n  users install it with:  fluxplugin install ${pkg.manifest.id}\n  (new GitHub topics can take a few minutes to show up in search)`);
    return { release: rel.json.html_url, repo, version: pkg.manifest.version, id: pkg.manifest.id };
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
}
