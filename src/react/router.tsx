import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { normalizePath, type Breadcrumb, type GuardResult, type RouteMatch, type RouteParams } from "../core/index.js";
import { PluginBoundary, usePluginFramework } from "./components.js";

/* ---------------------------------------------------------------- location */

function currentPath(): string {
  if (typeof window === "undefined") return "/";
  const h = window.location.hash.replace(/^#/, "");
  return normalizePath(h || "/");
}
const listeners = new Set<() => void>();
if (typeof window !== "undefined") window.addEventListener("hashchange", () => listeners.forEach((l) => l()));
const subscribeLocation = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = "#" + normalizePath(to) + (to.includes("?") ? "?" + to.split("?")[1] : "");
  if (opts.replace) window.location.replace(target);
  else window.location.hash = target;
  // Notify right away instead of waiting for the async `hashchange` event (duplicates are harmless:
  // subscribers compare the resulting path).
  listeners.forEach((l) => l());
}

export function useLocation(): string {
  return useSyncExternalStore(subscribeLocation, currentPath, () => "/");
}

export function useNavigate(): typeof navigate {
  return navigate;
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>): React.ReactElement {
  const here = useLocation();
  const active = here === normalizePath(to) || (to !== "/" && here.startsWith(normalizePath(to) + "/"));
  return (
    <a {...rest} href={"#" + normalizePath(to)} data-active={active || undefined} aria-current={active ? "page" : undefined}>
      {children}
    </a>
  );
}

/* ------------------------------------------------------------ route context */

interface RouteState {
  match: RouteMatch<any> | undefined;
  params: RouteParams;
  breadcrumbs: Breadcrumb[];
  path: string;
}
/**
 * Current route (params, breadcrumbs, match). Works anywhere under `PluginProvider` — e.g. a header rendering
 * breadcrumbs outside `<PluginRoutes>` — because it derives from the location and the route registry.
 */
export function usePluginRoute(): RouteState {
  const fw = usePluginFramework();
  const path = useLocation();
  const routes = fw.manager.routes;
  const version = useSyncExternalStore(routes.subscribe, () => routes.version, () => routes.version);
  return useMemo(() => {
    const match = routes.match(path);
    return { match, params: match?.params ?? {}, breadcrumbs: match ? routes.breadcrumbs(match) : [], path };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, path, version]);
}
export const useParams = (): RouteParams => usePluginRoute().params;
export function Breadcrumbs({ separator = "/" }: { separator?: ReactNode }): React.ReactElement | null {
  const { breadcrumbs } = usePluginRoute();
  if (!breadcrumbs.length) return null;
  return (
    <nav aria-label="Breadcrumb" className="flux-breadcrumbs">
      {breadcrumbs.map((b, i) => (
        <span key={b.path}>
          {i > 0 && <span className="flux-breadcrumb-sep"> {separator} </span>}
          {i === breadcrumbs.length - 1 ? <span aria-current="page">{b.label}</span> : <Link to={b.path}>{b.label}</Link>}
        </span>
      ))}
    </nav>
  );
}

/* ----------------------------------------------------------- lazy handling */

const lazyCache = new WeakMap<object, ComponentType<any>>();
function resolveComponent(def: { component?: unknown; lazy?: () => Promise<any> }): ComponentType<any> {
  if (def.component) return def.component as ComponentType<any>;
  const loader = def.lazy!;
  let c = lazyCache.get(loader);
  if (!c) {
    c = lazy(async () => {
      const mod = await loader();
      const comp = mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
      return { default: comp as ComponentType<any> };
    });
    lazyCache.set(loader, c);
  }
  return c;
}

/* --------------------------------------------------------------- the router */

export interface PluginRoutesProps {
  notFound?: ReactNode;
  forbidden?: (reason: string) => ReactNode;
  loading?: ReactNode;
  /** Layout used when a route does not name one. */
  defaultLayout?: ComponentType<{ children: ReactNode }>;
}

/**
 * Renders the route matching the current location from the dynamic route registry.
 * Plugins can add routes at any time; the router re-renders automatically. Routes owned by lazily-activated
 * plugins (`onRoute:` activation events) trigger activation on first navigation.
 */
export function PluginRoutes({ notFound, forbidden, loading, defaultLayout: DefaultLayout }: PluginRoutesProps): React.ReactElement {
  const fw = usePluginFramework();
  const path = useLocation();
  const routes = fw.manager.routes;
  useSyncExternalStore(routes.subscribe, () => routes.version, () => routes.version);
  const [resolution, setResolution] = useState<{ path: string; match?: RouteMatch<any>; guard?: GuardResult } | null>(null);

  const version = routes.version;
  useEffect(() => {
    let live = true;
    (async () => {
      const match = await routes.matchAsync(path);
      if (!match) return live && setResolution({ path });
      const guard = await routes.checkGuards(match, path);
      if (live) setResolution({ path, match, guard });
    })().catch(() => live && setResolution({ path }));
    return () => {
      live = false;
    };
  }, [routes, path, version]);

  useEffect(() => {
    if (resolution?.path === path && resolution.guard && !resolution.guard.allow && resolution.guard.redirect) navigate(resolution.guard.redirect, { replace: true });
  }, [resolution, path]);

  if (!resolution || resolution.path !== path) return <>{loading ?? null}</>;
  const { match, guard } = resolution;
  if (!match) return <>{notFound ?? <div className="flux-not-found">Page not found: {path}</div>}</>;
  if (guard && !guard.allow) {
    if (guard.redirect) return <>{loading ?? null}</>;
    return <>{forbidden ? forbidden(guard.reason) : <div className="flux-forbidden">Access denied: {guard.reason}</div>}</>;
  }

  // Build: innermost = the page; wrap with layouts from the deepest route to the root.
  const owner = match.route.owner ?? "host";
  const Page = resolveComponent(match.route.definition);
  let node: ReactNode = <Page params={match.params} />;
  for (const r of [...match.chain].reverse()) {
    const l = r.definition.layout;
    if (!l) continue;
    const Layout = (typeof l === "string" ? routes.getLayout(l) : l) as ComponentType<{ children: ReactNode }> | undefined;
    if (Layout) node = <Layout>{node}</Layout>;
  }
  if (!match.chain.some((r) => r.definition.layout) && DefaultLayout) node = <DefaultLayout>{node}</DefaultLayout>;

  return (
    <>
      <PluginBoundary key={match.route.fullPath} owner={owner}>
        <Suspense fallback={loading ?? <div className="flux-loading">Loading…</div>}>{node}</Suspense>
      </PluginBoundary>
    </>
  );
}

/** Menu entries for a location with active-route highlighting (sidebar, toolbar...). */
export function useMenu(location: import("../core/index.js").MenuLocation) {
  const fw = usePluginFramework();
  const menus = fw.manager.menus;
  useSyncExternalStore(menus.subscribe, () => menus.version, () => menus.version);
  const run = useCallback(
    (item: import("../core/index.js").MenuItemDefinition) => {
      if (item.command) return fw.manager.commands.execute(item.command, ...(item.args ?? []));
      if (item.path) navigate(item.path);
    },
    [fw],
  );
  return { items: menus.items(location), run };
}
