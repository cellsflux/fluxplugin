import React, {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  scopeCss,
  type IpcContract,
  type PluginConfig,
  type PluginInfo,
  type ResolvedSlotContribution,
} from "../core/index.js";
import { RendererFramework } from "./runtime.js";

/* ------------------------------------------------------------------ context */

const FrameworkContext = createContext<RendererFramework | null>(null);

export function PluginProvider({ framework, children }: { framework: RendererFramework; children: ReactNode }): React.ReactElement {
  return <FrameworkContext.Provider value={framework}>{children}</FrameworkContext.Provider>;
}

export function usePluginFramework(): RendererFramework {
  const fw = useContext(FrameworkContext);
  if (!fw) throw new Error("usePlugin* hooks must be used inside <PluginProvider>");
  return fw;
}

/* --------------------------------------------------------------- error boundary */

interface BoundaryProps {
  owner: string;
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

/** Isolates a plugin's UI: a throwing component renders a small fallback and is reported to the runtime. */
export class PluginErrorBoundary extends Component<BoundaryProps & { framework: RendererFramework }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.framework.reportRenderError(this.props.owner, error);
  }
  reset = (): void => this.setState({ error: null });
  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div role="alert" className="fluxplugin-error" data-flux-error={this.props.owner}>
        <strong>{this.props.owner}</strong> failed to render.{" "}
        <button type="button" onClick={this.reset}>
          Retry
        </button>
      </div>
    );
  }
}

/** Wraps plugin-provided UI: error boundary + `data-fluxplugin` attribute (used by scoped styles). */
export function PluginBoundary({ owner, children }: { owner: string; children: ReactNode }): React.ReactElement {
  const fw = usePluginFramework();
  return (
    <div data-fluxplugin={owner} style={{ display: "contents" }}>
      <PluginErrorBoundary owner={owner} framework={fw}>
        {children}
      </PluginErrorBoundary>
    </div>
  );
}

/* ------------------------------------------------------------------- slots */

function useRegistryVersion(subscribe: (l: () => void) => () => void, version: () => number): number {
  return useSyncExternalStore(subscribe, version, version);
}

function renderContribution(c: ResolvedSlotContribution<ComponentType<any>>, props: Record<string, unknown>): ReactNode {
  const C = c.component;
  return (
    <PluginBoundary key={c.id} owner={c.owner ?? "unknown"}>
      <C {...(c.props ?? {})} {...props} />
    </PluginBoundary>
  );
}

export interface PluginSlotProps {
  name: string;
  /** Host default content: kept, wrapped, or replaced depending on plugin contributions. */
  children?: ReactNode;
  /** Props handed to every contributed component. */
  props?: Record<string, unknown>;
}

/**
 * Declares an extension point in the host UI.
 * `before`/`prepend` contributions render above the default content, `after`/`append` below it and
 * a `replace` contribution takes its place.
 */
export function PluginSlot({ name, children, props = {} }: PluginSlotProps): React.ReactElement {
  const fw = usePluginFramework();
  useRegistryVersion(fw.manager.slots.subscribe, () => fw.manager.slots.version);
  const resolved = fw.manager.slots.resolve(name, props);
  return (
    <>
      {resolved.before.map((c) => renderContribution(c, props))}
      {resolved.replacement ? renderContribution(resolved.replacement, { ...props, children }) : children}
      {resolved.after.map((c) => renderContribution(c, props))}
    </>
  );
}

/** Data contributions to a declarative extension point (`ui.extend("dashboard", { toolbar: [...] })`). */
export function useExtensionItems<T = unknown>(point: string, key: string): T[] {
  const fw = usePluginFramework();
  const version = useRegistryVersion(fw.manager.extensionPoints.subscribe, () => fw.manager.extensionPoints.version);
  // Stable reference until the registry changes, so the result can safely be used in effect dependencies.
  return useMemo(() => fw.manager.extensionPoints.items<T>(point, key), [fw, point, key, version]);
}

/* ------------------------------------------------------------------- hooks */

export function usePlugin(id: string): PluginInfo | undefined {
  const fw = usePluginFramework();
  useRegistryVersion(fw.subscribe, () => fw.storeVersion);
  return fw.manager.has(id) ? fw.manager.info(id) : undefined;
}

export function usePlugins(): PluginInfo[] {
  const fw = usePluginFramework();
  useRegistryVersion(fw.subscribe, () => fw.storeVersion);
  return fw.manager.list();
}

/** Reactive per-plugin state (same store as `ctx.state` inside the plugin). */
export function usePluginState<T>(pluginId: string, key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const fw = usePluginFramework();
  const store = fw.manager.stateOf(pluginId);
  const sub = useCallback((l: () => void) => store.subscribe(l, key).dispose, [store, key]);
  const value = useSyncExternalStore(
    sub,
    () => store.get<T>(key, initial),
    () => initial,
  );
  const set = useCallback((v: T | ((p: T) => T)) => store.set(key, typeof v === "function" ? (v as (p: T) => T)(store.get<T>(key, initial)) : v), [store, key, initial]);
  return [value, set];
}

/**
 * Subscribes to an event. Looks at the renderer event bus *and* at pushes from the main process
 * (`ctx.ipc.send(channel, payload)` and broadcast events). Returns the latest payload.
 */
export function usePluginEvent<T = unknown>(name: string, onEvent?: (payload: T) => void): T | undefined {
  const fw = usePluginFramework();
  const [last, setLast] = useState<T | undefined>(undefined);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const handle = (p: unknown): void => {
      setLast(p as T);
      cb.current?.(p as T);
    };
    const subs = [fw.manager.events.on(name, (p) => handle(p)), fw.bridge.on(name, handle), fw.bridge.on(`flux.event.${name}`, handle)];
    return () => {
      subs.forEach((s) => (typeof s === "function" ? s() : s.dispose()));
    };
  }, [fw, name]);
  return last;
}

export function usePluginCommand<R = unknown>(id: string): { run: (...args: unknown[]) => Promise<R>; available: boolean; title?: string } {
  const fw = usePluginFramework();
  useRegistryVersion(fw.manager.commands.subscribe, () => fw.manager.commands.version);
  const cmd = fw.manager.commands.get(id);
  const run = useCallback((...args: unknown[]) => fw.manager.commands.execute<R>(id, ...args), [fw, id]);
  return { run, available: !!cmd && (!cmd.when || cmd.when()), title: cmd?.title };
}

export function usePluginService<T = unknown>(name: string): T | undefined {
  const fw = usePluginFramework();
  useRegistryVersion(fw.manager.services.subscribe, () => fw.manager.services.version);
  useEffect(() => {
    // Activates the provider lazily when the service is declared with `onService:<name>`.
    if (!fw.manager.services.has(name)) void fw.manager.services.resolveAsync(name).catch(() => undefined);
  }, [fw, name]);
  return fw.manager.services.resolve<T>(name);
}

export interface InvokeState<O> {
  data: O | undefined;
  error: Error | undefined;
  loading: boolean;
}

/** Calls an IPC endpoint (by name or shared contract) with loading/error state. */
export function usePluginIPC<I = unknown, O = unknown>(
  endpoint: string | IpcContract<I, O>,
  opts: { caller?: string } = {},
): InvokeState<O> & { call: (input?: I) => Promise<O> } {
  const fw = usePluginFramework();
  const name = typeof endpoint === "string" ? endpoint : endpoint.name;
  const [state, setState] = useState<InvokeState<O>>({ data: undefined, error: undefined, loading: false });
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const call = useCallback(
    async (input?: I): Promise<O> => {
      setState((s) => ({ ...s, loading: true, error: undefined }));
      try {
        const data = (await fw.bridge.invoke(name, input, opts.caller)) as O;
        if (alive.current) setState({ data, error: undefined, loading: false });
        return data;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if (alive.current) setState({ data: undefined, error, loading: false });
        throw error;
      }
    },
    [fw, name, opts.caller],
  );
  return { ...state, call };
}

/** Current route match: params, breadcrumbs and route meta. */
export { usePluginRoute } from "./router.js";

export function usePluginConfig<T extends Record<string, any> = Record<string, any>>(pluginId: string): {
  config: T | undefined;
  loading: boolean;
  error: Error | undefined;
  set: PluginConfig<T>["set"];
  reset: PluginConfig<T>["reset"];
} {
  const fw = usePluginFramework();
  const handle = useMemo(() => fw.configOf<T>(pluginId), [fw, pluginId]);
  const [config, setConfig] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    handle
      .get()
      .then((c) => live && (setConfig(c), setError(undefined)))
      .catch((e) => live && setError(e as Error))
      .finally(() => live && setLoading(false));
    const sub = fw.manager.events.on("plugin.config.changed", (p: any) => {
      if (p?.id === pluginId) setConfig(p.next as T);
    });
    return () => {
      live = false;
      sub.dispose();
    };
  }, [fw, handle, pluginId]);
  return {
    config,
    loading,
    error,
    set: async (patch) => {
      const next = await handle.set(patch);
      setConfig(next);
      return next;
    },
    reset: async () => {
      const next = await handle.reset();
      setConfig(next);
      return next;
    },
  };
}

/* ---------------------------------------------------------------- style host */

/**
 * Mirrors the style registry into the document: `<style>` for inline css, `<link>` for hrefs.
 * Disabling/reloading a plugin removes or replaces its styles because the registry entries disappear.
 */
export function StyleHost(): null {
  const fw = usePluginFramework();
  useRegistryVersion(fw.manager.styles.subscribe, () => fw.manager.styles.version);
  const entries = fw.manager.styles.ordered();
  const sig = entries.map((e) => `${e.owner}/${e.id}/${e.priority}/${e.css?.length ?? 0}/${e.href ?? ""}`).join("|");
  useEffect(() => {
    const created: HTMLElement[] = [];
    for (const e of entries) {
      let el: HTMLElement;
      if (e.href) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = e.href;
        el = link;
      } else {
        const style = document.createElement("style");
        style.textContent = e.scoped ? scopeCss(e.css ?? "", e.owner) : (e.css ?? "");
        el = style;
      }
      el.setAttribute("data-flux-style", `${e.owner}:${e.id}`);
      document.head.appendChild(el);
      created.push(el);
    }
    return () => created.forEach((el) => el.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return null;
}
