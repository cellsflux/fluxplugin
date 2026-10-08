import { FrameworkError, toDisposable, type Disposable } from "./common.js";
import type { MenuLocation, Permission } from "./manifest.js";
import { Registry } from "./registry.js";

export type RouteParams = Record<string, string>;

export interface RouteGuardContext {
  path: string;
  params: RouteParams;
  route: ResolvedRoute;
  /** Host-provided state (current user, feature flags...) — see `RouteRegistry.guardContext`. */
  host: Record<string, unknown>;
}
/** Return `true`/`undefined` to allow, `false` to block, or a string path to redirect. */
export type RouteGuard = (ctx: RouteGuardContext) => boolean | string | void | Promise<boolean | string | void>;

export interface RouteMeta {
  title?: string;
  icon?: unknown;
  /** Static label or function computing it from params (e.g. loaded entity name). */
  breadcrumb?: string | ((params: RouteParams) => string);
  /** Adds an automatic menu entry for this route. */
  menu?: false | { location?: MenuLocation; label?: string; order?: number; group?: string };
  [key: string]: unknown;
}

export interface RouteDefinition<C = unknown> {
  path: string;
  /** Component to render (any framework — the core does not care). */
  component?: C;
  /** Code-split loader. Resolved by the renderer adapter. */
  lazy?: () => Promise<{ default: C } | C>;
  /** Id of a registered layout, or a component used directly as the layout. */
  layout?: string | C;
  children?: RouteDefinition<C>[];
  /** `protected` routes require the host `isAuthenticated` guard (see RouteRegistry.guardContext) — default is `public`. */
  access?: "public" | "protected";
  /** Permission the *plugin* must hold (declared in manifest) to register this route. */
  permission?: Permission;
  guards?: RouteGuard[];
  meta?: RouteMeta;
}

export interface ResolvedRoute<C = unknown> {
  /** Full normalized path pattern, e.g. `/settings/analytics/:id`. */
  fullPath: string;
  definition: RouteDefinition<C>;
  owner?: string;
  /** Ancestors from root to this route (excluding itself). */
  parents: ResolvedRoute<C>[];
  segments: Seg[];
  score: number;
}

type Seg = { type: "static"; value: string } | { type: "param"; name: string } | { type: "splat" };

export interface RouteMatch<C = unknown> {
  route: ResolvedRoute<C>;
  params: RouteParams;
  /** Ancestors + route, root first (used to nest layouts and build breadcrumbs). */
  chain: ResolvedRoute<C>[];
}

export interface Breadcrumb {
  label: string;
  path: string;
}

export type GuardResult = { allow: true } | { allow: false; redirect?: string; reason: string };

export function normalizePath(path: string): string {
  const clean = "/" + path.split("?")[0]!.split("#")[0]!.split("/").filter(Boolean).join("/");
  return clean;
}

function toSegments(fullPath: string): Seg[] {
  return fullPath
    .split("/")
    .filter(Boolean)
    .map((s): Seg => (s === "*" ? { type: "splat" } : s.startsWith(":") ? { type: "param", name: s.slice(1) } : { type: "static", value: s }));
}

function scoreOf(segs: Seg[]): number {
  // Static segments weigh the most, then params, then splats; longer paths are more specific.
  return segs.reduce((n, s) => n + (s.type === "static" ? 100 : s.type === "param" ? 10 : 1), segs.length);
}

function joinPaths(base: string, child: string): string {
  if (child.startsWith("/")) return normalizePath(child);
  return normalizePath(`${base}/${child}`);
}

export class RouteRegistry<C = unknown> extends Registry<ResolvedRoute<C>> {
  /** Host-provided values handed to guards (e.g. `{ isAuthenticated: true }`). */
  guardContext: Record<string, unknown> = {};
  /** Set by the plugin manager to lazily activate plugins declaring `onRoute:<path>`. */
  beforeResolve?: (path: string) => Promise<void>;
  /** Called for every route with `meta.menu`: lets the manager create sidebar entries automatically. */
  onRouteRegistered?: (route: ResolvedRoute<C>, owner?: string) => Disposable | void;
  private layouts = new Map<string, C>();

  constructor() {
    super("Route");
  }

  registerLayout(id: string, component: C): Disposable {
    if (this.layouts.has(id)) throw new FrameworkError(`Layout "${id}" is already registered`, "FLUX_DUPLICATE");
    this.layouts.set(id, component);
    this.bump();
    return toDisposable(() => {
      this.layouts.delete(id);
      this.bump();
    });
  }

  getLayout(id: string): C | undefined {
    return this.layouts.get(id);
  }

  private bump(): void {
    // Layouts affect rendering but are not keyed items: force a change notification.
    (this as unknown as { changed(): void }).changed();
  }

  /** Registers a route (and its children). Returns one disposable removing all of them. */
  register(def: RouteDefinition<C>, owner?: string): Disposable {
    const disposables: Disposable[] = [];
    const walk = (d: RouteDefinition<C>, parent: ResolvedRoute<C> | undefined): void => {
      if (!d.component && !d.lazy && !d.children?.length) {
        throw new FrameworkError(`Route "${d.path}" needs a component, a lazy loader or children`, "FLUX_INVALID_ROUTE", owner);
      }
      const fullPath = parent ? joinPaths(parent.fullPath, d.path) : normalizePath(d.path);
      const segments = toSegments(fullPath);
      const resolved: ResolvedRoute<C> = {
        fullPath,
        definition: d,
        owner,
        parents: parent ? [...parent.parents, parent] : [],
        segments,
        score: scoreOf(segments),
      };
      // Pure layout routes (no component of their own) are not directly matchable but kept for chains.
      disposables.push(this.add(`${owner ?? ""}|${fullPath}`, resolved, owner));
      const extra = this.onRouteRegistered?.(resolved, owner);
      if (extra) disposables.push(extra);
      for (const child of d.children ?? []) walk(child, resolved);
    };
    try {
      walk(def, undefined);
    } catch (e) {
      for (const d of disposables.reverse()) d.dispose();
      throw e;
    }
    return toDisposable(() => {
      for (const d of disposables.reverse()) d.dispose();
    });
  }

  /** Finds the best route for a concrete pathname. */
  match(pathname: string): RouteMatch<C> | undefined {
    const target = normalizePath(pathname)
      .split("/")
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
    let best: RouteMatch<C> | undefined;
    for (const route of this.list()) {
      const def = route.definition;
      if (!def.component && !def.lazy) continue;
      const params: RouteParams = {};
      let ok = true;
      const segs = route.segments;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]!;
        if (seg.type === "splat") {
          params["*"] = target.slice(i).join("/");
          if (target.length < i) ok = false;
          break;
        }
        const t = target[i];
        if (t === undefined) {
          ok = false;
          break;
        }
        if (seg.type === "static" && seg.value !== t) {
          ok = false;
          break;
        }
        if (seg.type === "param") params[seg.name] = t;
        if (i === segs.length - 1 && target.length > segs.length) ok = false;
      }
      if (ok && segs.length === 0 && target.length > 0) ok = false;
      if (!ok) continue;
      if (!best || route.score > best.route.score) best = { route, params, chain: [...route.parents, route] };
    }
    return best;
  }

  /** Same as `match` but first lets lazily-activated plugins register their routes. */
  async matchAsync(pathname: string): Promise<RouteMatch<C> | undefined> {
    const first = this.match(pathname);
    if (first) return first;
    await this.beforeResolve?.(normalizePath(pathname));
    return this.match(pathname);
  }

  /** Evaluates `access`, then every guard from the root layout down to the route itself. */
  async checkGuards(m: RouteMatch<C>, pathname: string): Promise<GuardResult> {
    for (const r of m.chain) {
      const base: RouteGuardContext = { path: normalizePath(pathname), params: m.params, route: m.route as ResolvedRoute, host: this.guardContext };
      if (r.definition.access === "protected" && !this.guardContext["isAuthenticated"]) {
        return { allow: false, redirect: (this.guardContext["loginPath"] as string | undefined) ?? "/login", reason: "authentication required" };
      }
      for (const g of r.definition.guards ?? []) {
        let res: boolean | string | void;
        try {
          res = await g(base);
        } catch (e) {
          return { allow: false, reason: `guard threw: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (typeof res === "string") return { allow: false, redirect: res, reason: "redirected by guard" };
        if (res === false) return { allow: false, reason: "blocked by guard" };
      }
    }
    return { allow: true };
  }

  breadcrumbs(m: RouteMatch<C>): Breadcrumb[] {
    const out: Breadcrumb[] = [];
    for (const r of m.chain) {
      const b = r.definition.meta?.breadcrumb ?? r.definition.meta?.title;
      if (!b) continue;
      const label = typeof b === "function" ? b(m.params) : b;
      const path = r.fullPath.replace(/:([A-Za-z0-9_]+)/g, (_, k: string) => encodeURIComponent(m.params[k] ?? `:${k}`));
      out.push({ label, path });
    }
    return out;
  }
}
