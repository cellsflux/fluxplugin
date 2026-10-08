import type { PluginManifest } from "./manifest.js";
import { satisfies } from "./semver.js";

export type DependencyIssue =
  | { type: "missing"; plugin: string; dependency: string; range: string; kind: "dependencies" | "peerDependencies" }
  | { type: "version"; plugin: string; dependency: string; range: string; found: string }
  | { type: "cycle"; plugin: string; path: string[] };

export interface DependencyGraph {
  manifests: Map<string, PluginManifest>;
  /** Hard edges (dependencies + peerDependencies) plus optional ones that are installed. */
  edges: Map<string, string[]>;
  issues: DependencyIssue[];
  /** Plugins that cannot be activated because of an issue (own or inherited from a dependency). */
  blocked: Set<string>;
  /** Global topological order (dependencies first) of every non-blocked plugin. */
  order: string[];
}

export function buildDependencyGraph(manifests: Iterable<PluginManifest>): DependencyGraph {
  const map = new Map<string, PluginManifest>();
  for (const m of manifests) map.set(m.id, m);
  const issues: DependencyIssue[] = [];
  const edges = new Map<string, string[]>();
  const blocked = new Set<string>();

  for (const m of map.values()) {
    const out: string[] = [];
    for (const kind of ["dependencies", "peerDependencies"] as const) {
      for (const [dep, range] of Object.entries(m[kind] ?? {})) {
        const target = map.get(dep);
        if (!target) {
          issues.push({ type: "missing", plugin: m.id, dependency: dep, range, kind });
          blocked.add(m.id);
          continue;
        }
        if (!satisfies(target.version, range)) {
          issues.push({ type: "version", plugin: m.id, dependency: dep, range, found: target.version });
          blocked.add(m.id);
          continue;
        }
        out.push(dep);
      }
    }
    for (const [dep, range] of Object.entries(m.optionalDependencies ?? {})) {
      const target = map.get(dep);
      if (target && satisfies(target.version, range)) out.push(dep);
    }
    edges.set(m.id, out);
  }

  // Cycle detection + topological sort (iterative-safe recursion depth is bounded by plugin count).
  const state = new Map<string, 0 | 1 | 2>(); // 0 = unseen, 1 = visiting, 2 = done
  const order: string[] = [];
  const stack: string[] = [];
  const visit = (id: string): void => {
    const st = state.get(id) ?? 0;
    if (st === 2) return;
    if (st === 1) {
      const path = [...stack.slice(stack.indexOf(id)), id];
      issues.push({ type: "cycle", plugin: id, path });
      for (const p of path) blocked.add(p);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dep of edges.get(id) ?? []) visit(dep);
    stack.pop();
    state.set(id, 2);
    order.push(id);
  };
  for (const id of [...map.keys()].sort()) visit(id);

  // Propagate blocking to dependents (transitively).
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, deps] of edges) {
      if (!blocked.has(id) && deps.some((d) => blocked.has(d))) {
        blocked.add(id);
        changed = true;
      }
    }
  }

  return { manifests: map, edges, issues, blocked, order: order.filter((id) => !blocked.has(id)) };
}

/** `id` preceded by all of its transitive dependencies, dependencies first. */
export function activationOrderFor(graph: DependencyGraph, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: string): void => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of graph.edges.get(n) ?? []) walk(d);
    out.push(n);
  };
  walk(id);
  return out;
}

/** Plugins that (transitively) require `id`, ordered so that each one comes before what it depends on (safe deactivation order). */
export function dependentsOf(graph: DependencyGraph, id: string): string[] {
  const reverse = new Map<string, string[]>();
  for (const [p, deps] of graph.edges) for (const d of deps) (reverse.get(d) ?? reverse.set(d, []).get(d)!).push(p);
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const walk = (n: string): void => {
    for (const p of reverse.get(n) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      walk(p);
      out.push(p); // post-order: deepest dependents first
    }
  };
  walk(id);
  return out;
}

export function describeIssue(i: DependencyIssue): string {
  switch (i.type) {
    case "missing":
      return `${i.plugin} requires "${i.dependency}" (${i.range}) which is not installed`;
    case "version":
      return `${i.plugin} requires "${i.dependency}" ${i.range} but ${i.found} is installed`;
    case "cycle":
      return `dependency cycle: ${i.path.join(" → ")}`;
  }
}
