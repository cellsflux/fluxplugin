import { compareVersions, isValidVersion, parseVersion, satisfies } from "./semver.js";
import type { RegistryEntryLike } from "./protocol.js";

/** One plugin as listed by a store. The same shape is used by registries (main) and by the UI. */
export type CatalogEntry = RegistryEntryLike;

export const isPaid = (e: CatalogEntry): boolean => !!e.pricing && e.pricing.model !== "free";

export interface CatalogConflict {
  id: string;
  version: string;
  sources: string[];
  fields: string[];
}

/**
 * One entry per plugin **id** (never per name or per version). Winner = highest valid semver; on a tie the store listed first in
 * `sourceOrder` wins. Other versions are kept as `versions`, every store listing it as `sources`. Contradicting metadata for the
 * same id+version is reported in `conflicts` and flagged on the entry — never merged silently.
 */
export function dedupeEntries(raw: CatalogEntry[], sourceOrder: string[] = []): { entries: CatalogEntry[]; conflicts: CatalogConflict[] } {
  const rank = (s: string) => {
    const i = sourceOrder.indexOf(s);
    return i < 0 ? 1e6 : i;
  };
  const groups = new Map<string, CatalogEntry[]>();
  for (const e of raw) if (e && typeof e.id === "string") (groups.get(e.id) ?? groups.set(e.id, []).get(e.id)!).push(e);
  const entries: CatalogEntry[] = [];
  const conflicts: CatalogConflict[] = [];
  for (const [id, list] of groups) {
    const sorted = [...list].sort((a, b) => {
      const va = isValidVersion(a.version);
      const vb = isValidVersion(b.version);
      if (va !== vb) return va ? -1 : 1;
      return (va && vb ? compareVersions(b.version, a.version) : 0) || rank(a.source) - rank(b.source);
    });
    const win = sorted[0]!;
    const same = sorted.filter((e) => e.version === win.version);
    const fields = new Set<string>();
    for (const o of same.slice(1)) {
      if (o.name !== win.name) fields.add("name");
      if (o.sha256 && win.sha256 && o.sha256 !== win.sha256) fields.add("package checksum");
      if ([...(o.permissions ?? [])].sort().join() !== [...(win.permissions ?? [])].sort().join()) fields.add("permissions");
    }
    if (fields.size) conflicts.push({ id, version: win.version, sources: same.map((e) => e.source), fields: [...fields] });
    entries.push({ ...win, versions: [...new Set(sorted.map((e) => e.version))], sources: [...new Set(list.map((e) => e.source))], conflict: fields.size ? [...fields] : undefined });
  }
  return { entries: entries.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), conflicts };
}

export interface CatalogQuery {
  q?: string;
  category?: string;
  price?: "all" | "free" | "paid";
  sort?: "name" | "updated" | "popular";
  page?: number;
  pageSize?: number;
}
export interface Page<T> {
  items: T[];
  /** Items matching the filters (all pages). */
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export function filterEntries(entries: CatalogEntry[], q: Pick<CatalogQuery, "q" | "category" | "price">): CatalogEntry[] {
  const text = (q.q ?? "").trim().toLowerCase();
  return entries.filter((e) => {
    if (q.category && !(e.categories ?? []).includes(q.category)) return false;
    if (q.price === "free" && isPaid(e)) return false;
    if (q.price === "paid" && !isPaid(e)) return false;
    return !text || `${e.id} ${e.name} ${e.description ?? ""} ${e.author ?? ""} ${(e.keywords ?? []).join(" ")}`.toLowerCase().includes(text);
  });
}

export function paginate<T>(items: T[], page = 1, pageSize = 10): Page<T> {
  const size = Math.max(1, Math.floor(pageSize) || 10);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { items: items.slice((p - 1) * size, p * size), total: items.length, page: p, pageSize: size, pages };
}

export function categoriesOf(entries: CatalogEntry[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const e of entries) for (const c of e.categories ?? []) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function sortEntries(entries: CatalogEntry[], sort: CatalogQuery["sort"] = "name"): CatalogEntry[] {
  const by: Record<string, (a: CatalogEntry, b: CatalogEntry) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    updated: (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.name.localeCompare(b.name),
    popular: (a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name),
  };
  return [...entries].sort(by[sort] ?? by["name"]!);
}

/** The pipeline behind the Store screen: filter → sort → paginate. Filtering always happens before paging. */
export function queryCatalog(all: CatalogEntry[], q: CatalogQuery = {}): Page<CatalogEntry> & { totalAll: number; categories: { name: string; count: number }[] } {
  return { ...paginate(sortEntries(filterEntries(all, q), q.sort), q.page, q.pageSize), totalAll: all.length, categories: categoriesOf(all) };
}

/** What is known about an installed plugin version: enough to detect any change later. */
export interface InstalledSnapshot {
  id: string;
  version: string;
  permissions: string[];
  dependencies: Record<string, string>;
  name?: string;
  description?: string;
  license?: string;
  provides?: string[];
  /** sha256 of every runtime file. */
  files: Record<string, string>;
  packageSha256?: string;
}

export interface SnapshotDiff {
  files: { added: string[]; removed: string[]; changed: string[] };
  permissions: { added: string[]; removed: string[] };
  dependencies: { added: string[]; removed: string[]; changed: string[] };
  metadata: string[];
}

const keysDiff = (a: Record<string, string>, b: Record<string, string>) => ({
  added: Object.keys(b).filter((k) => !(k in a)).sort(),
  removed: Object.keys(a).filter((k) => !(k in b)).sort(),
  changed: Object.keys(b).filter((k) => k in a && a[k] !== b[k]).sort(),
});

export function diffSnapshots(from: Omit<InstalledSnapshot, "id" | "packageSha256">, to: Omit<InstalledSnapshot, "id" | "packageSha256">): SnapshotDiff {
  const pa = new Set(from.permissions);
  const pb = new Set(to.permissions);
  const metadata: string[] = [];
  for (const k of ["name", "description", "license"] as const) if ((from[k] ?? "") !== (to[k] ?? "")) metadata.push(k);
  if ([...(from.provides ?? [])].sort().join() !== [...(to.provides ?? [])].sort().join()) metadata.push("provides");
  return {
    files: keysDiff(from.files, to.files),
    permissions: { added: [...pb].filter((p) => !pa.has(p)).sort(), removed: [...pa].filter((p) => !pb.has(p)).sort() },
    dependencies: keysDiff(from.dependencies, to.dependencies),
    metadata,
  };
}

export interface UpdateAnalysis {
  /** `update`: offer the button. `inconsistent`: same version but different content — never replaced silently. */
  status: "up-to-date" | "update" | "downgrade" | "inconsistent" | "unknown";
  from: string;
  to: string;
  major: boolean;
  /** Only known when the store publishes per-file hashes. */
  files: SnapshotDiff["files"] | null;
  permissions: SnapshotDiff["permissions"];
  dependencies: SnapshotDiff["dependencies"];
  metadata: string[];
  notes: { version: string; notes: string }[];
  /** True when the user must review before updating (new permissions, new/changed dependencies, major version). */
  needsConfirmation: boolean;
  reasons: string[];
}

export function analyzeUpdate(installed: InstalledSnapshot, remote: CatalogEntry): UpdateAnalysis {
  const rf = remote.hashes;
  const d = diffSnapshots(installed, { version: remote.version, permissions: remote.permissions ?? [], dependencies: remote.dependencies ?? {}, name: remote.name, description: remote.description, license: remote.license, provides: remote.provides, files: rf ?? {} } as never);
  const files = rf ? d.files : null;
  const cmp = isValidVersion(remote.version) && isValidVersion(installed.version) ? compareVersions(remote.version, installed.version) : NaN;
  const major = !Number.isNaN(cmp) && cmp > 0 && parseVersion(remote.version)!.major > parseVersion(installed.version)!.major;
  const reasons: string[] = [];
  let status: UpdateAnalysis["status"];
  if (Number.isNaN(cmp)) status = "unknown";
  else if (cmp > 0) status = "update";
  else if (cmp < 0) status = "downgrade";
  else {
    const filesDiffer = !!files && (files.added.length || files.removed.length || files.changed.length);
    const pkgDiffers = !!remote.sha256 && !!installed.packageSha256 && remote.sha256 !== installed.packageSha256;
    status = filesDiffer || pkgDiffers ? "inconsistent" : "up-to-date";
    if (status === "inconsistent") reasons.push("The published files differ from the installed ones although the version number is the same. Nothing was replaced; ask the author to publish a new version.");
  }
  const notes = (remote.updates ?? []).filter((n) => isValidVersion(n.version) && compareVersions(n.version, installed.version) > 0 && compareVersions(n.version, remote.version) <= 0).sort((a, b) => compareVersions(b.version, a.version));
  if (status === "update") {
    if (d.permissions.added.length) reasons.push(`asks for new permissions: ${d.permissions.added.join(", ")}`);
    if (d.dependencies.added.length || d.dependencies.changed.length) reasons.push(`dependency changes: ${[...d.dependencies.added, ...d.dependencies.changed].join(", ")}`);
    if (major) reasons.push("major version: may contain breaking changes");
  }
  return { status, from: installed.version, to: remote.version, major, files, permissions: d.permissions, dependencies: d.dependencies, metadata: d.metadata, notes, needsConfirmation: status === "update" && reasons.length > 0, reasons };
}

export interface PlanStep {
  entry: CatalogEntry;
  reason: "requested" | "dependency";
  action: "install" | "update";
  requiredBy: string[];
}
export interface PlanProblem {
  code: "missing" | "unavailable" | "incompatible" | "cycle" | "conflict" | "license";
  plugin: string;
  message: string;
}
export interface InstallPlan {
  /** Dependencies first, the requested plugin last. Installed, compatible dependencies are not listed (never reinstalled). */
  steps: PlanStep[];
  problems: PlanProblem[];
  /** Permissions the user is asked to review (union over all steps). */
  permissions: string[];
  ok: boolean;
}
export interface PlanContext {
  installed: Map<string, { version: string; conflicts?: string[] }>;
  /** Every known version of a plugin across the stores. */
  candidates: (id: string) => CatalogEntry[];
}

/**
 * What must be installed for `root`: transitive dependencies, version ranges (all constraints on a plugin must hold at once),
 * circular dependencies, declared conflicts, missing/unavailable plugins. Pure: nothing is installed here.
 */
export function planInstall(root: CatalogEntry, ctx: PlanContext): InstallPlan {
  const steps = new Map<string, PlanStep>();
  const order: string[] = [];
  const problems: PlanProblem[] = [];
  const ranges = new Map<string, { range: string; by: string }[]>();
  const stack: string[] = [];
  const done = new Set<string>();
  const addProblem = (p: PlanProblem) => void (problems.some((x) => x.code === p.code && x.plugin === p.plugin && x.message === p.message) || problems.push(p));

  const visit = (entry: CatalogEntry): void => {
    if (stack.includes(entry.id)) return addProblem({ code: "cycle", plugin: entry.id, message: `circular dependency: ${[...stack.slice(stack.indexOf(entry.id)), entry.id].join(" → ")}` });
    if (done.has(entry.id)) return;
    stack.push(entry.id);
    for (const [dep, range] of Object.entries(entry.dependencies ?? {})) {
      (ranges.get(dep) ?? ranges.set(dep, []).get(dep)!).push({ range, by: entry.id });
      const all = ranges.get(dep)!;
      const inst = ctx.installed.get(dep);
      if (inst && all.every((r) => satisfies(inst.version, r.range))) continue;
      const cands = ctx.candidates(dep).filter((c) => isValidVersion(c.version));
      const fit = cands.filter((c) => all.every((r) => satisfies(c.version, r.range))).sort((a, b) => compareVersions(b.version, a.version));
      if (!fit.length) {
        const wants = all.map((r) => `${r.by} needs ${r.range}`).join(", ");
        if (!cands.length && !inst) addProblem({ code: "unavailable", plugin: dep, message: `"${dep}" is required by ${entry.id} (${range}) but is not available in your stores` });
        else if (inst && !cands.length) addProblem({ code: "incompatible", plugin: dep, message: `"${dep}" ${inst.version} is installed but ${entry.id} needs ${range}, and no other version is available` });
        else addProblem({ code: "conflict", plugin: dep, message: `no version of "${dep}" satisfies every requirement (${wants})` });
        continue;
      }
      const best = fit[0]!;
      const prev = steps.get(dep);
      if (prev) steps.set(dep, { ...prev, entry: prev.entry.version === best.version ? prev.entry : best, requiredBy: [...new Set([...prev.requiredBy, entry.id])] });
      else steps.set(dep, { entry: best, reason: "dependency", action: inst ? "update" : "install", requiredBy: [entry.id] });
      visit(steps.get(dep)!.entry);
    }
    stack.pop();
    done.add(entry.id);
    if (!order.includes(entry.id)) order.push(entry.id);
  };

  steps.set(root.id, { entry: root, reason: "requested", action: ctx.installed.has(root.id) ? "update" : "install", requiredBy: [] });
  visit(root);

  const ids = new Set([...ctx.installed.keys(), ...steps.keys()]);
  for (const s of steps.values()) {
    for (const c of s.entry.conflicts ?? []) if (ids.has(c) && c !== s.entry.id) addProblem({ code: "conflict", plugin: s.entry.id, message: `"${s.entry.name}" is incompatible with "${c}"` });
    for (const [iid, i] of ctx.installed) if ((i.conflicts ?? []).includes(s.entry.id)) addProblem({ code: "conflict", plugin: s.entry.id, message: `installed plugin "${iid}" declares that it is incompatible with "${s.entry.name}"` });
  }
  const ordered = order.filter((id) => steps.has(id)).map((id) => steps.get(id)!);
  return { steps: ordered, problems, permissions: [...new Set(ordered.flatMap((s) => s.entry.permissions ?? []))].sort(), ok: problems.length === 0 };
}
