import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffSnapshots, validateManifest, type InstalledSnapshot, type SnapshotDiff } from "../core/index.js";
import { copyPluginRuntime } from "../main/index.js";

const SNAPSHOT = "updates/.snapshot.json";
const START = "<!-- auto:start -->";
const END = "<!-- auto:end -->";

/** The released state of a plugin: manifest facts + the hash of every runtime file. */
export async function snapshotOf(root: string): Promise<InstalledSnapshot> {
  const raw = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
  const m = validateManifest(raw).manifest;
  if (!m) throw new Error("invalid plugin.json");
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "flux-notes-"));
  try {
    const files: Record<string, string> = {};
    for (const f of (await copyPluginRuntime(root, stage)).sort()) {
      if (f.startsWith("updates/")) continue; // the notes themselves are not part of the change
      files[f] = crypto.createHash("sha256").update(await fs.readFile(path.join(stage, f))).digest("hex");
    }
    return { id: m.id, version: m.version, name: m.name, description: m.description, license: m.license, provides: m.provides, permissions: m.permissions ?? [], dependencies: { ...m.dependencies, ...m.peerDependencies }, files };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

const list = (title: string, items: string[]) => (items.length ? `### ${title}\n\n${items.map((i) => `- ${i}`).join("\n")}\n\n` : "");

/** Markdown of the detected differences between two released states. */
export function renderChanges(d: SnapshotDiff | undefined, from?: string): string {
  if (!d) return "First release.\n";
  const hasCode = (d.files.added.length + d.files.removed.length + d.files.changed.length) > 0;
  let out = from ? `Changes since **${from}**.\n\n` : "";
  out += list("Files added", d.files.added.map((f) => `\`${f}\``));
  out += list("Files removed", d.files.removed.map((f) => `\`${f}\``));
  out += list("Files changed", d.files.changed.map((f) => `\`${f}\``));
  out += list("Permissions", [...d.permissions.added.map((p) => `**new:** \`${p}\` — review it before updating`), ...d.permissions.removed.map((p) => `removed: \`${p}\``)]);
  out += list("Dependencies", [...d.dependencies.added.map((p) => `added \`${p}\``), ...d.dependencies.removed.map((p) => `removed \`${p}\``), ...d.dependencies.changed.map((p) => `range changed for \`${p}\``)]);
  out += list("Metadata", d.metadata.map((m) => `\`${m}\` changed`));
  return out.trim() ? out : hasCode ? "" : "No distributed file changed.\n";
}

/**
 * Creates `updates/<version>.md` from the differences with the previously released state (`updates/.snapshot.json`).
 * The developer owns everything outside the `auto` block: regeneration only rewrites the block, so manual notes
 * (new features, fixes, breaking changes, post-update steps) are never lost.
 */
export async function generateNotes(root: string, opts: { commit?: boolean } = {}): Promise<{ file: string; created: boolean; version: string }> {
  const cur = await snapshotOf(root);
  let prev: InstalledSnapshot | undefined;
  try {
    prev = JSON.parse(await fs.readFile(path.join(root, SNAPSHOT), "utf8"));
  } catch {
    /* first release */
  }
  const base = prev && prev.version !== cur.version ? prev : (prev as (InstalledSnapshot & { base?: InstalledSnapshot }) | undefined)?.base;
  const diff = base ? diffSnapshots(base, cur) : undefined;
  const auto = `${START}\n## Detected changes\n\n${renderChanges(diff, base?.version)}${END}`;
  const dir = path.join(root, "updates");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${cur.version}.md`);
  const existing = await fs.readFile(file, "utf8").catch(() => undefined);
  let content: string;
  if (existing === undefined) {
    content = `# ${cur.name ?? cur.id} ${cur.version}\n\n<!-- Write what is new for users here: features, fixes, breaking changes, steps to do after updating. -->\n\n${auto}\n`;
  } else if (existing.includes(START) && existing.includes(END)) {
    content = existing.slice(0, existing.indexOf(START)) + auto + existing.slice(existing.indexOf(END) + END.length);
  } else content = `${existing.trimEnd()}\n\n${auto}\n`;
  await fs.writeFile(file, content);
  // The snapshot of the last *released* version becomes the baseline of the next one; the baseline of the current one is kept for re-runs.
  if (opts.commit !== false) await fs.writeFile(path.join(root, SNAPSHOT), JSON.stringify(prev && prev.version === cur.version ? { ...cur, base } : { ...cur, base: prev }, null, 2));
  return { file, created: existing === undefined, version: cur.version };
}

/** Release notes shipped in `updates/`, newest first (used by the store catalog and the details page). */
export async function readNotes(root: string): Promise<{ version: string; notes: string }[]> {
  const out: { version: string; notes: string }[] = [];
  for (const f of await fs.readdir(path.join(root, "updates")).catch(() => [])) {
    if (/^\d+\.\d+\.\d+.*\.md$/i.test(f)) out.push({ version: f.replace(/\.md$/i, ""), notes: (await fs.readFile(path.join(root, "updates", f), "utf8")).slice(0, 20_000) });
  }
  return out.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}
