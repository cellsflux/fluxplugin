import {
  MGMT,
  PermissionManager,
  PluginManager,
  errorMessage,
  type Bootstrap,
  type FluxBridge,
  type IpcContract,
  type IpcErrorPayload,
  type Permission,
  type PluginConfig,
  type PluginDefinition,
  type PluginDetails,
  type PluginInfo,
  type PluginManagerOptions,
  type PreloadApiSpec,
  type RegistryEntryLike,
  type RendererPluginDescriptor,
} from "../core/index.js";

export class RemoteError extends Error {
  constructor(public readonly payload: IpcErrorPayload) {
    super(payload.message);
    this.name = "RemoteError";
  }
  get code(): string {
    return this.payload.code;
  }
}

/** Typed client for the `flux.plugins.*` management API served by the main process. */
export class PluginsClient {
  constructor(private readonly bridge: FluxBridge) {}
  private call<T>(channel: string, input?: unknown): Promise<T> {
    return this.bridge.invoke(channel, input) as Promise<T>;
  }
  list = () => this.call<PluginInfo[]>(MGMT.list);
  enable = (id: string) => this.call<PluginInfo[]>(MGMT.enable, { id });
  disable = (id: string) => this.call<PluginInfo[]>(MGMT.disable, { id });
  reload = (id: string) => this.call<PluginInfo[]>(MGMT.reload, { id });
  grant = (id: string, permission: Permission) => this.call<PluginInfo>(MGMT.grant, { id, permission });
  revoke = (id: string, permission: Permission) => this.call<PluginInfo>(MGMT.revoke, { id, permission });
  uninstall = (id: string) => this.call<PluginInfo[]>(MGMT.uninstall, { id });
  search = (query?: string) => this.call<RegistryEntryLike[]>(MGMT.search, { query });
  updates = () => this.call<RegistryEntryLike[]>(MGMT.updates);
  install = (entry: RegistryEntryLike) => this.call<{ id: string; version: string }>(MGMT.install, { entry });
  update = (entry: RegistryEntryLike) => this.call<{ id: string; version: string }>(MGMT.update, { entry });
  rollback = (id: string, version?: string) => this.call<{ id: string; version: string }>(MGMT.rollback, { id, version });
  configGet = <T = Record<string, unknown>>(id: string) => this.call<T>(MGMT.configGet, { id });
  configSet = <T = Record<string, unknown>>(id: string, patch: Partial<T>) => this.call<T>(MGMT.configSet, { id, patch });
  configReset = <T = Record<string, unknown>>(id: string) => this.call<T>(MGMT.configReset, { id });
  configSchema = (id: string) => this.call<import("../core/index.js").SchemaDescription | null>(MGMT.configSchema, { id });
  logs = (id?: string) => this.call<import("../core/index.js").LogEntry[]>(MGMT.logs, { id });
  details = (id: string) => this.call<PluginDetails>(MGMT.details, { id });
  diagnostics = (id: string) => this.call<{ info: PluginInfo; logs: import("../core/index.js").LogEntry[]; contributions: Record<string, number> }>(MGMT.diagnostics, { id });
}

export interface RendererFrameworkOptions {
  bridge: FluxBridge;
  /**
   * How to import a plugin's renderer entry. Defaults to a dynamic `import(url)`.
   * Hosts using a bundler can map ids to static imports (e.g. `import.meta.glob`) for dev.
   */
  importPlugin?: (url: string, descriptor: RendererPluginDescriptor) => Promise<unknown>;
  /** Called when a plugin component keeps crashing; defaults to disabling it in main + renderer. */
  maxRenderErrors?: number;
  manager?: Partial<PluginManagerOptions>;
}

const asDefinition = (mod: unknown): PluginDefinition<any> => {
  const d = (mod && typeof mod === "object" && "default" in (mod as object) ? (mod as { default: unknown }).default : mod) as PluginDefinition<any>;
  if (!d || typeof d !== "object") throw new Error("renderer entry must default-export definePlugin({...})");
  return d;
};

/**
 * The renderer half of the framework. The main process stays the source of truth for *which* plugins exist, are
 * enabled and which permissions were granted; the renderer mirrors that state (`sync`) and runs the renderer
 * entries inside its own `PluginManager` (runtime = "renderer").
 */
export class RendererFramework {
  readonly bridge: FluxBridge;
  readonly client: PluginsClient;
  readonly manager: PluginManager;
  private readonly permissions = new PermissionManager({ autoGrant: false });
  private revision = -1;
  private bootstrap: Bootstrap | undefined;
  private syncing: Promise<void> = Promise.resolve();
  private renderErrors = new Map<string, number[]>();
  private unsubscribers: (() => void)[] = [];
  private storeListeners = new Set<() => void>();
  private _storeVersion = 0;

  constructor(private readonly opts: RendererFrameworkOptions) {
    this.bridge = opts.bridge;
    this.client = new PluginsClient(opts.bridge);
    this.manager = new PluginManager({
      runtime: "renderer",
      permissions: this.permissions,
      ipcBridge: {
        invoke: (name, input, caller) => opts.bridge.invoke(name, input, caller),
        send: (channel, payload, caller) => opts.bridge.send(channel, payload, caller),
        on: (channel, fn) => ({ dispose: opts.bridge.on(channel, fn) }),
      },
      // Renderer plugins that crash must never take the app down; the main side persists auto-disable.
      ...opts.manager,
    });
    this.manager.subscribe(() => this.touch());
  }

  /** `useSyncExternalStore` plumbing for the bootstrap-derived view (plugin list etc.). */
  get storeVersion(): number {
    return this._storeVersion + this.manager.version;
  }
  subscribe = (l: () => void): (() => void) => {
    this.storeListeners.add(l);
    const off = this.manager.subscribe(l);
    return () => {
      this.storeListeners.delete(l);
      off();
    };
  };
  private touch(): void {
    this._storeVersion++;
    for (const l of [...this.storeListeners]) l();
  }

  get currentBootstrap(): Bootstrap | undefined {
    return this.bootstrap;
  }

  /** Fetches the bootstrap, activates enabled plugins and starts listening for changes. */
  async start(): Promise<void> {
    await this.sync();
    this.unsubscribers.push(
      this.bridge.on(MGMT.changed, () => {
        void this.sync().catch((e) => console.error("[fluxplugin] sync failed", e));
      }),
      this.bridge.on("flux.notification", (n: any) => void this.manager.notifications.push(n, n?.owner ?? "main")),
      this.bridge.on("flux.event.plugin.hotreload", ({ id }: any = {}) => void this.hotReload(id)),
    );
  }

  stop(): void {
    for (const u of this.unsubscribers.splice(0)) u();
  }

  private hotReload(id: string | undefined): Promise<void> {
    // Bump the module URL so `import()` fetches a fresh copy, then re-sync.
    this.cacheBust = Date.now();
    return this.sync(true).then(async () => {
      if (id && this.manager.has(id)) await this.manager.reload(id).catch(() => undefined);
    });
  }
  private cacheBust = 0;

  /** Mirrors main-process state into the renderer manager. Calls are serialized. */
  sync(force = false): Promise<void> {
    const run = this.syncing.then(async () => {
      const boot = await this.bridge.bootstrap();
      if (!force && boot.revision === this.revision && this.bootstrap) return;
      this.revision = boot.revision;
      this.bootstrap = boot;
      await this.reconcile(boot);
      this.installWindowPlugins(boot.preload);
      this.touch();
    });
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async reconcile(boot: Bootstrap): Promise<void> {
    const seen = new Set<string>();
    for (const d of boot.plugins) {
      seen.add(d.id);
      this.permissions.restore({ [d.id]: d.granted });
      if (!this.manager.has(d.id)) {
        if (d.state === "error" && !d.rendererUrl) continue; // rejected by main (validation / integrity)
        this.manager.register({ manifest: d.manifest, origin: "renderer", load: () => this.load(d) });
        this.permissions.restore({ [d.id]: d.granted });
      } else {
        // Refresh grants in place; declare() would reset them, so restore + notify only.
        this.permissions.restore({ [d.id]: d.granted });
      }
      const info = this.manager.info(d.id);
      if (!d.enabled && info.enabled) await this.manager.disable(d.id).catch(() => undefined);
      else if (d.enabled && !info.enabled) await this.manager.enable(d.id, { activate: false }).catch(() => undefined);
    }
    for (const info of this.manager.list()) if (!seen.has(info.id)) await this.manager.unregister(info.id);
    // Activate plugins that want to start immediately (idempotent for the ones already running).
    await this.manager.startup();
  }

  private async load(d: RendererPluginDescriptor): Promise<PluginDefinition<any>> {
    let def: PluginDefinition<any> = {};
    if (d.rendererUrl) {
      const url = this.cacheBust ? `${d.rendererUrl}${d.rendererUrl.includes("?") ? "&" : "?"}flux=${this.cacheBust}` : d.rendererUrl;
      const mod = await (this.opts.importPlugin ? this.opts.importPlugin(url, d) : import(/* @vite-ignore */ url));
      def = asDefinition(mod);
    }
    const hrefs = d.styleUrls;
    if (!hrefs.length) return def;
    // Manifest-declared stylesheets are loaded on activation and removed on deactivation by the owner sweep.
    const activate = def.onActivate ?? def.activate;
    return {
      ...def,
      onActivate: async (ctx) => {
        hrefs.forEach((href, i) => ctx.lifecycle.subscriptions.add(this.manager.styles.register({ id: `manifest-${i}`, href, priority: 50 }, ctx.pluginId)));
        await activate?.(ctx);
      },
      activate: undefined,
    };
  }

  /** Called by plugin error boundaries. Repeated render failures disable the plugin. */
  reportRenderError(pluginId: string, error: unknown): void {
    this.manager.logs.logger(pluginId).error(`render error: ${errorMessage(error)}`, error instanceof Error ? error.stack : undefined);
    const now = Date.now();
    const list = [...(this.renderErrors.get(pluginId) ?? []).filter((t) => now - t < 60_000), now];
    this.renderErrors.set(pluginId, list);
    if (list.length >= (this.opts.maxRenderErrors ?? 3) && this.manager.has(pluginId) && this.manager.info(pluginId).enabled) {
      this.manager.logs.logger(pluginId).warn("disabled automatically after repeated render errors");
      this.renderErrors.delete(pluginId);
      void this.client.disable(pluginId).catch(() => this.manager.disable(pluginId));
    }
  }

  /** Builds `window.plugins.<ns>.<member>` from the preload manifest. Rebuilt on every sync. */
  private installWindowPlugins(spec: Record<string, PreloadApiSpec>): void {
    if (typeof window === "undefined") return;
    (window as unknown as { plugins: unknown }).plugins = buildPluginApis(this.bridge, spec);
  }

  /** Config handle usable from React (mirrors ctx.config through the management API). */
  configOf<T extends Record<string, any>>(id: string): Pick<PluginConfig<T>, "get" | "set" | "reset"> {
    return {
      get: () => this.client.configGet<T>(id),
      set: (p) => this.client.configSet<T>(id, p),
      reset: () => this.client.configReset<T>(id),
    };
  }
}

/** Generates the object behind `window.plugins` from a preload manifest. Functions only; no references to Node. */
export function buildPluginApis(bridge: FluxBridge, spec: Record<string, PreloadApiSpec>): Record<string, Record<string, (...args: any[]) => any>> {
  const out: Record<string, Record<string, (...args: any[]) => any>> = {};
  for (const [ns, members] of Object.entries(spec)) {
    const api: Record<string, (...args: any[]) => any> = Object.create(null);
    for (const [name, m] of Object.entries(members)) {
      if (m.kind === "invoke") api[name] = (input?: unknown) => bridge.invoke(m.channel, input, ns);
      else if (m.kind === "send") api[name] = (payload?: unknown) => bridge.send(m.channel, payload, ns);
      else api[name] = (listener: (p: unknown) => void) => bridge.on(m.channel, listener);
    }
    out[ns] = Object.freeze(api) as typeof api;
  }
  return Object.freeze(out) as typeof out;
}

/** Shares singletons (React, the runtime...) with plugin bundles, which import them from `globalThis.__FLUXPLUGIN_SHARED__`. */
export function installSharedModules(modules: Record<string, unknown>): void {
  const g = globalThis as unknown as { __FLUXPLUGIN_SHARED__?: Record<string, unknown> };
  g.__FLUXPLUGIN_SHARED__ = { ...(g.__FLUXPLUGIN_SHARED__ ?? {}), ...modules };
}

export type { IpcContract };
