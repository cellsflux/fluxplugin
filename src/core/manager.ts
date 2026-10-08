import {
  DisposableStore,
  FrameworkError,
  LifecycleError,
  LogStore,
  type Logger,
  errorMessage,
  toDisposable,
  withTimeout,
  type Disposable,
} from "./common.js";
import { activationOrderFor, buildDependencyGraph, dependentsOf, describeIssue, type DependencyGraph } from "./deps.js";
import { EventBus } from "./events.js";
import { HookSystem } from "./hooks.js";
import { IpcRegistry, PreloadRegistry } from "./ipc.js";
import { FRAMEWORK_VERSION, validateManifest, type Permission, type PluginManifest } from "./manifest.js";
import { PermissionManager } from "./permissions.js";
import type { PluginContext, PluginDefinition, PluginInfo, PluginState, Runtime } from "./plugin.js";
import { CommandRegistry, MenuRegistry, ServiceRegistry } from "./registry.js";
import { RouteRegistry, normalizePath } from "./routes.js";
import { s } from "./schema.js";
import { ExtensionPointRegistry, SlotRegistry } from "./slots.js";
import { MemoryStorageBackend, createPluginConfig, createPluginState, createPluginStorage, type PluginConfig, type PluginState_, type StorageBackend } from "./storage.js";
import { StyleRegistry } from "./styles.js";
import { NotificationCenter } from "./notifications.js";
import { matchesPattern } from "./events.js";

export interface PluginSource {
  /** Raw manifest (validated on registration). */
  manifest: unknown;
  /** Absolute plugin directory (main process). */
  root?: string;
  /** Human-readable origin, e.g. `dir:/plugins/foo`. */
  origin?: string;
  /** Imports the plugin entry for this runtime. Must return a *fresh* module on every call (hot reload). */
  load(): Promise<PluginDefinition<any>>;
}

export type Phase = "load" | "initialize" | "activate" | "ready" | "deactivate" | "unload";

export interface IpcBridge {
  invoke(name: string, input: unknown, caller: string): Promise<unknown>;
  send(channel: string, payload: unknown, caller: string): void;
  on(channel: string, fn: (payload: unknown) => void): Disposable;
}

export interface HostApiProvider<T = unknown> {
  factory: (who: { pluginId: string; root?: string; manifest: PluginManifest }) => T;
  permission?: Permission;
}

export interface PluginManagerOptions {
  runtime: Runtime;
  storage?: StorageBackend;
  permissions?: PermissionManager;
  logs?: LogStore;
  frameworkVersion?: string;
  timeouts?: Partial<Record<Phase, number>>;
  /** Plugins crashing this many times inside `crashWindowMs` are disabled automatically. Default 3. */
  maxCrashes?: number;
  crashWindowMs?: number;
  /** Persists the list of disabled plugin ids. */
  stateStore?: { load(): Promise<string[]>; save(ids: string[]): Promise<void> };
  /** Renderer runtimes route IPC through this bridge instead of the (empty) local registry. */
  ipcBridge?: IpcBridge;
  /** Called when a plugin emits an event with `{ broadcast: true }` (forward it to the other process). */
  onBroadcastEvent?: (name: string, payload: unknown, source: string) => void;
  /** Reject slot contributions to slots the host did not declare. */
  strictSlots?: boolean;
}

interface PluginRecord {
  id: string;
  manifest: PluginManifest;
  source: PluginSource;
  state: PluginState;
  enabled: boolean;
  definition?: PluginDefinition<any>;
  context?: PluginContext<any>;
  config?: PluginConfig<any>;
  store: DisposableStore;
  deactivators: (() => void | Promise<void>)[];
  lazy: Disposable[];
  crashes: number[];
  error?: { message: string; phase: string; time: number };
  warnings: string[];
  inflight?: Promise<void>;
}

const DEFAULT_TIMEOUTS: Record<Phase, number> = { load: 15_000, initialize: 10_000, activate: 15_000, ready: 10_000, deactivate: 10_000, unload: 10_000 };

export class PluginManager {
  readonly runtime: Runtime;
  readonly logs: LogStore;
  readonly permissions: PermissionManager;
  readonly events: EventBus;
  readonly hooks: HookSystem;
  readonly commands = new CommandRegistry();
  readonly menus = new MenuRegistry();
  readonly routes = new RouteRegistry<any>();
  readonly services = new ServiceRegistry();
  readonly slots = new SlotRegistry<any>();
  readonly extensionPoints = new ExtensionPointRegistry();
  readonly ipc = new IpcRegistry();
  readonly preload = new PreloadRegistry();
  readonly styles = new StyleRegistry();
  readonly notifications = new NotificationCenter();
  readonly storageBackend: StorageBackend;

  private readonly records = new Map<string, PluginRecord>();
  private readonly states = new Map<string, PluginState_>();
  private readonly hostApis = new Map<string, HostApiProvider>();
  private readonly timeouts: Record<Phase, number>;
  private readonly log: Logger;
  private listeners = new Set<() => void>();
  private _version = 0;
  private disposedFlag = false;

  constructor(private readonly opts: PluginManagerOptions) {
    this.runtime = opts.runtime;
    this.logs = opts.logs ?? new LogStore();
    this.log = this.logs.logger("core");
    this.storageBackend = opts.storage ?? new MemoryStorageBackend();
    this.permissions = opts.permissions ?? new PermissionManager();
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.events = new EventBus((e, name, pattern) => this.log.error(`event listener for "${pattern}" failed on "${name}": ${errorMessage(e)}`));
    this.hooks = new HookSystem((e, name, owner) => this.logs.logger(owner ?? "core").error(`hook "${name}" failed: ${errorMessage(e)}`));
    this.wireLazyActivation();
    // Keep permission changes visible to UIs.
    this.permissions.onChange(() => this.changed());
  }

  /* ------------------------------------------------------------- observers */

  get version(): number {
    return this._version;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  private changed(): void {
    this._version++;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* ignore */
      }
    }
  }

  /* ------------------------------------------------------------ host APIs */

  /** Exposes a controlled capability to plugins (`context.host.api(name)`), optionally gated by a permission. */
  provide<T>(name: string, factory: HostApiProvider<T>["factory"], permission?: Permission): Disposable {
    if (this.hostApis.has(name)) throw new FrameworkError(`Host API "${name}" already provided`, "FLUX_DUPLICATE");
    this.hostApis.set(name, { factory, permission });
    return toDisposable(() => this.hostApis.delete(name));
  }

  /* --------------------------------------------------- discovery / validate */

  /** Persisted state (disabled plugins) must be loaded before registering sources. */
  async init(): Promise<void> {
    const disabled = (await this.opts.stateStore?.load()) ?? [];
    this.persistedDisabled = new Set(disabled);
  }
  private persistedDisabled = new Set<string>();

  /**
   * Discovers + validates one plugin. Invalid plugins are recorded in the `error` state (so the UI can show why)
   * and never throw — one broken plugin must not stop the others.
   */
  register(source: PluginSource): PluginInfo {
    const v = validateManifest(source.manifest, { frameworkVersion: this.opts.frameworkVersion ?? FRAMEWORK_VERSION });
    const raw = source.manifest as { id?: unknown; name?: unknown; version?: unknown };
    const id = v.manifest?.id ?? (typeof raw?.id === "string" ? raw.id : `invalid-${this.records.size}`);
    if (this.records.has(id)) {
      this.log.warn(`plugin "${id}" is already registered; ignoring duplicate from ${source.origin ?? "unknown origin"}`);
      return this.info(id);
    }
    const manifest =
      v.manifest ??
      ({
        id,
        name: typeof raw?.name === "string" ? raw.name : id,
        version: typeof raw?.version === "string" ? raw.version : "0.0.0",
        activationEvents: [],
        deactivationEvents: [],
        permissions: [],
        dependencies: {},
        optionalDependencies: {},
        peerDependencies: {},
        engines: {},
        contributes: {},
        screenshots: [],
        categories: [],
        keywords: [],
        links: {},
      } as PluginManifest);
    const rec: PluginRecord = {
      id,
      manifest,
      source,
      state: v.ok ? "validated" : "error",
      enabled: !this.persistedDisabled.has(id),
      store: new DisposableStore(),
      deactivators: [],
      lazy: [],
      crashes: [],
      warnings: v.warnings,
    };
    if (!v.ok) {
      rec.error = { message: v.issues.map((i) => `${i.path || "<root>"}: ${i.message}`).join("; "), phase: "validate", time: Date.now() };
      this.logs.logger(id).error(`manifest validation failed: ${rec.error.message}`);
    } else {
      this.permissions.declare(id, manifest.permissions);
      if (!rec.enabled) rec.state = "disabled";
    }
    this.records.set(id, rec);
    if (v.ok && rec.enabled) this.installLazyProxies(rec);
    this.log.info(`discovered ${id}@${manifest.version} (${rec.state})`);
    this.events.emit("plugin.registered", { id }, "core");
    this.changed();
    return this.info(id);
  }

  async unregister(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) return;
    await this.deactivate(id).catch(() => undefined);
    await this.unload(id).catch(() => undefined);
    for (const d of rec.lazy.splice(0)) d.dispose();
    this.permissions.forget(id);
    this.records.delete(id);
    this.events.emit("plugin.unregistered", { id }, "core");
    this.changed();
  }

  /* ----------------------------------------------------------- inspection */

  has(id: string): boolean {
    return this.records.has(id);
  }

  list(): PluginInfo[] {
    return [...this.records.keys()].sort().map((id) => this.info(id));
  }

  info(id: string): PluginInfo {
    const rec = this.mustGet(id);
    const m = rec.manifest;
    const graph = this.graph();
    const author = typeof m.author === "string" ? m.author : m.author?.name;
    return {
      id,
      name: m.name,
      version: m.version,
      description: m.description,
      author,
      state: rec.state,
      enabled: rec.enabled,
      runtime: this.runtime,
      permissions: this.permissions.snapshot(id),
      dependencies: { ...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies },
      dependents: dependentsOf(graph, id),
      activationEvents: m.activationEvents ?? [],
      contributes: m.contributes ?? {},
      error: rec.error,
      crashes: rec.crashes.length,
      hasConfig: !!rec.definition?.config,
      root: rec.source.root,
      origin: rec.source.origin,
      warnings: rec.warnings,
    };
  }

  /** Reactive per-plugin state store (same instance as `ctx.state`). Survives reloads. */
  stateOf(id: string): PluginState_ {
    let s = this.states.get(id);
    if (!s) this.states.set(id, (s = createPluginState()));
    return s;
  }

  /** Validated manifest (or the best-effort one for plugins rejected at validation). */
  manifest(id: string): PluginManifest {
    return this.mustGet(id).manifest;
  }

  getConfig<T extends Record<string, any> = Record<string, any>>(id: string): PluginConfig<T> | undefined {
    return this.records.get(id)?.config as PluginConfig<T> | undefined;
  }

  /** Active plugin's context (for hosts and tests). */
  contextOf(id: string): PluginContext | undefined {
    return this.records.get(id)?.context;
  }

  diagnostics(id: string): { info: PluginInfo; logs: ReturnType<LogStore["query"]>; contributions: Record<string, number> } {
    const owned = (r: { listByOwner(o: string): unknown[] }) => r.listByOwner(id).length;
    return {
      info: this.info(id),
      logs: this.logs.query({ source: id }),
      contributions: {
        commands: owned(this.commands),
        menus: owned(this.menus),
        routes: owned(this.routes),
        services: owned(this.services),
        slots: owned(this.slots),
        extensions: owned(this.extensionPoints),
        ipc: owned(this.ipc),
        preload: owned(this.preload),
        styles: owned(this.styles),
      },
    };
  }

  private mustGet(id: string): PluginRecord {
    const r = this.records.get(id);
    if (!r) throw new FrameworkError(`Unknown plugin "${id}"`, "FLUX_UNKNOWN_PLUGIN");
    return r;
  }

  private graph(): DependencyGraph {
    return buildDependencyGraph([...this.records.values()].filter((r) => r.state !== "error" || r.error?.phase !== "validate").map((r) => r.manifest));
  }

  /* ------------------------------------------------------------ activation */

  /** Activates every plugin that wants to start with the application (`onStartup`, `*`, or no activation events). */
  async startup(): Promise<void> {
    const graph = this.graph();
    for (const issue of graph.issues) this.log.warn(describeIssue(issue));
    const ids = graph.order.filter((id) => {
      const r = this.records.get(id)!;
      const ev = r.manifest.activationEvents ?? [];
      return r.enabled && (ev.length === 0 || ev.includes("onStartup") || ev.includes("*"));
    });
    // Isolation: every plugin is activated independently; failures are recorded, never propagated.
    for (const id of ids) await this.activate(id).catch(() => undefined);
  }

  /** Activates `id` and, first, everything it depends on. Rejects with a `LifecycleError` on failure. */
  async activate(id: string): Promise<void> {
    const rec = this.mustGet(id);
    if (!rec.enabled) throw new LifecycleError(id, "activate", "plugin is disabled");
    if (rec.state === "error" && rec.error?.phase === "validate") throw new LifecycleError(id, "validate", rec.error.message);
    const graph = this.graph();
    if (graph.blocked.has(id)) {
      const reasons = graph.issues.filter((i) => i.plugin === id || (i.type === "cycle" && i.path.includes(id))).map(describeIssue);
      throw new LifecycleError(id, "activate", reasons.join("; ") || "a dependency cannot be activated");
    }
    await this.ensureReady(id, graph, []);
  }

  private async ensureReady(id: string, graph: DependencyGraph, chain: string[]): Promise<void> {
    const rec = this.mustGet(id);
    if (rec.state === "ready") return;
    if (rec.inflight) return rec.inflight;
    if (!rec.enabled) throw new LifecycleError(id, "activate", "plugin is disabled");
    if (chain.includes(id)) throw new LifecycleError(id, "activate", `dependency cycle: ${[...chain, id].join(" → ")}`);
    const optional = new Set(Object.keys(rec.manifest.optionalDependencies ?? {}).filter((d) => !(d in (rec.manifest.dependencies ?? {})) && !(d in (rec.manifest.peerDependencies ?? {}))));
    const run = (async () => {
      for (const dep of graph.edges.get(id) ?? []) {
        try {
          await this.ensureReady(dep, graph, [...chain, id]);
        } catch (e) {
          if (optional.has(dep)) {
            this.logs.logger(id).warn(`optional dependency "${dep}" could not be activated: ${errorMessage(e)}`);
            continue;
          }
          const err = new LifecycleError(id, "activate", `required dependency "${dep}" failed: ${errorMessage(e)}`, e);
          await this.fail(rec, "activate", err, false);
          throw err;
        }
      }
      await this.bringUp(rec);
    })();
    rec.inflight = run;
    try {
      await run;
    } finally {
      rec.inflight = undefined;
    }
  }

  private async phase<T>(rec: PluginRecord, phase: Phase, fn: () => Promise<T> | T): Promise<T> {
    try {
      return await withTimeout(Promise.resolve().then(fn), this.timeouts[phase], `${phase} of "${rec.id}"`, rec.id);
    } catch (e) {
      if (e instanceof LifecycleError) throw e;
      throw new LifecycleError(rec.id, phase, errorMessage(e), e);
    }
  }

  private setState(rec: PluginRecord, state: PluginState): void {
    rec.state = state;
    this.events.emit("plugin.state", { id: rec.id, state }, "core");
    this.changed();
  }

  private async bringUp(rec: PluginRecord): Promise<void> {
    let phase: Phase = "load";
    try {
      if (!rec.definition) {
        const def = await this.phase(rec, "load", () => rec.source.load());
        if (!def || typeof def !== "object") throw new Error("entry did not export a plugin definition (use definePlugin)");
        if (def.id && def.id !== rec.id) throw new Error(`plugin id mismatch: manifest "${rec.id}" vs entry "${def.id}"`);
        rec.definition = def;
        rec.context = this.createContext(rec);
        this.setState(rec, "loaded");
        await this.phase(rec, "load", () => def.onLoad?.(rec.context!));
      }
      const def = rec.definition;
      const ctx = rec.context!;

      phase = "initialize";
      this.setState(rec, "initialized");
      await this.phase(rec, "initialize", () => def.onInitialize?.(ctx));

      phase = "activate";
      this.removeLazyProxies(rec);
      await this.phase(rec, "activate", async () => {
        await this.applyDeclarative(rec);
        await (def.onActivate ?? def.activate)?.(ctx);
      });
      this.setState(rec, "activated");

      phase = "ready";
      await this.phase(rec, "ready", () => def.onReady?.(ctx));
      rec.error = undefined;
      this.setState(rec, "ready");
      this.logs.logger(rec.id).info("ready");
      this.events.emit("plugin.ready", { id: rec.id }, "core");
    } catch (e) {
      await this.fail(rec, phase, e, true);
      throw e;
    }
  }

  /** Records a failure, tears down everything the plugin registered and auto-disables repeat offenders. */
  private async fail(rec: PluginRecord, phase: string, e: unknown, cleanup: boolean): Promise<void> {
    const message = errorMessage(e);
    this.logs.logger(rec.id).error(`${phase} failed: ${message}`, e instanceof Error ? e.stack : undefined);
    if (cleanup) this.teardown(rec);
    rec.error = { message, phase, time: Date.now() };
    const now = Date.now();
    const windowMs = this.opts.crashWindowMs ?? 60_000;
    rec.crashes = [...rec.crashes.filter((t) => now - t < windowMs), now];
    this.events.emit("plugin.error", { id: rec.id, phase, message }, "core");
    if (rec.crashes.length >= (this.opts.maxCrashes ?? 3)) {
      rec.enabled = false;
      this.logs.logger(rec.id).warn(`disabled automatically after ${rec.crashes.length} failures`);
      await this.persistDisabled();
      this.setState(rec, "disabled");
      this.events.emit("plugin.autodisabled", { id: rec.id }, "core");
    } else {
      this.setState(rec, "error");
    }
    if (rec.enabled) this.installLazyProxies(rec);
  }

  /** Disposes every contribution of a plugin (store + owner-based sweep as a safety net). */
  private teardown(rec: PluginRecord): void {
    rec.store.dispose();
    rec.store = new DisposableStore();
    rec.deactivators = [];
    this.sweep(rec.id);
  }

  private sweep(owner: string): void {
    this.commands.unregisterByOwner(owner);
    this.menus.unregisterByOwner(owner);
    this.routes.unregisterByOwner(owner);
    this.services.unregisterByOwner(owner);
    this.slots.unregisterByOwner(owner);
    this.extensionPoints.unregisterByOwner(owner);
    this.ipc.unregisterByOwner(owner);
    this.ipc.removeListenersByOwner(owner);
    this.preload.unregisterByOwner(owner);
    this.styles.unregisterByOwner(owner);
    this.hooks.removeByOwner(owner);
  }

  /* ---------------------------------------------------------- deactivation */

  /** Deactivates `id` after deactivating every active plugin that depends on it. Never throws for plugin errors. */
  async deactivate(id: string): Promise<void> {
    const rec = this.mustGet(id);
    const graph = this.graph();
    for (const dep of dependentsOf(graph, id)) {
      const d = this.records.get(dep);
      if (d && (d.state === "ready" || d.state === "activated" || d.state === "initialized" || d.state === "loaded")) await this.deactivateOne(d);
    }
    if (rec.inflight) await rec.inflight.catch(() => undefined);
    await this.deactivateOne(rec);
  }

  private async deactivateOne(rec: PluginRecord): Promise<void> {
    if (!["ready", "activated", "initialized", "loaded", "error"].includes(rec.state)) return;
    const log = this.logs.logger(rec.id);
    const def = rec.definition;
    const ctx = rec.context;
    if (def && ctx && rec.state !== "error") {
      try {
        await this.phase(rec, "deactivate", () => (def.onDeactivate ?? def.deactivate)?.(ctx));
      } catch (e) {
        log.error(`deactivate hook failed: ${errorMessage(e)}`);
      }
    }
    for (const fn of [...rec.deactivators].reverse()) {
      try {
        await fn();
      } catch (e) {
        log.error(`cleanup failed: ${errorMessage(e)}`);
      }
    }
    this.teardown(rec);
    this.setState(rec, "deactivated");
    if (rec.enabled) this.installLazyProxies(rec);
    this.events.emit("plugin.deactivated", { id: rec.id }, "core");
  }

  async unload(id: string): Promise<void> {
    const rec = this.mustGet(id);
    if (rec.state === "ready" || rec.state === "activated") await this.deactivate(id);
    const def = rec.definition;
    const ctx = rec.context;
    if (def && ctx) {
      try {
        await this.phase(rec, "unload", () => def.onUnload?.(ctx));
      } catch (e) {
        this.logs.logger(id).error(`unload hook failed: ${errorMessage(e)}`);
      }
    }
    rec.definition = undefined;
    rec.context = undefined;
    rec.config = undefined;
    if (rec.state !== "disabled" && !(rec.state === "error" && rec.error?.phase === "validate")) this.setState(rec, "unloaded");
  }

  async disable(id: string): Promise<void> {
    const rec = this.mustGet(id);
    await this.deactivate(id);
    await this.unload(id);
    rec.enabled = false;
    for (const d of rec.lazy.splice(0)) d.dispose();
    await this.persistDisabled();
    this.setState(rec, "disabled");
  }

  async enable(id: string, opts: { activate?: boolean } = {}): Promise<void> {
    const rec = this.mustGet(id);
    rec.enabled = true;
    rec.crashes = [];
    rec.error = undefined;
    await this.persistDisabled();
    this.setState(rec, "validated");
    this.installLazyProxies(rec);
    if (opts.activate ?? true) await this.activate(id);
  }

  /** Development hot reload: deactivate → unload → load a fresh module → activate (if it was active). */
  async reload(id: string): Promise<void> {
    const rec = this.mustGet(id);
    const wasActive = rec.state === "ready" || (rec.state === "error" && rec.error?.phase !== "validate");
    await this.deactivate(id);
    await this.unload(id);
    rec.error = undefined;
    if (rec.enabled && rec.state !== "disabled") this.setState(rec, "validated");
    this.events.emit("plugin.reloading", { id }, "core");
    if (wasActive || rec.manifest.activationEvents?.includes("onStartup")) await this.activate(id);
    this.events.emit("plugin.reloaded", { id }, "core");
  }

  private async persistDisabled(): Promise<void> {
    const ids = [...this.records.values()].filter((r) => !r.enabled).map((r) => r.id);
    this.persistedDisabled = new Set(ids);
    try {
      await this.opts.stateStore?.save(ids);
    } catch (e) {
      this.log.error(`could not persist plugin state: ${errorMessage(e)}`);
    }
  }

  async dispose(): Promise<void> {
    this.disposedFlag = true;
    const graph = this.graph();
    for (const id of [...graph.order].reverse()) await this.deactivate(id).catch(() => undefined);
    for (const id of this.records.keys()) await this.unload(id).catch(() => undefined);
    this.events.removeAll();
  }

  /* ------------------------------------------------- lazy activation events */

  /** Activates plugins whose manifest lists `event` (or `*`). Used internally and by hosts for custom events. */
  async trigger(event: string): Promise<void> {
    if (this.disposedFlag) return;
    const targets = [...this.records.values()].filter((r) => {
      if (!r.enabled || r.state === "ready" || r.state === "error" || r.state === "disabled") return false;
      if (r.inflight) return true;
      return (r.manifest.activationEvents ?? []).some((e) => e === event || this.eventMatches(e, event));
    });
    await Promise.all(targets.map((r) => this.activate(r.id).catch(() => undefined)));
  }

  private eventMatches(declared: string, event: string): boolean {
    const [kd, ...rd] = declared.split(":");
    const [ke, ...re] = event.split(":");
    if (kd !== ke) return false;
    const pd = rd.join(":");
    const pe = re.join(":");
    if (kd === "onRoute") return routePatternMatches(pd, pe);
    return matchesPattern(pd, pe);
  }

  private wireLazyActivation(): void {
    this.commands.beforeExecute = (id) => this.trigger(`onCommand:${id}`);
    this.services.beforeResolve = (name) => this.trigger(`onService:${name}`);
    this.routes.beforeResolve = (path) => this.trigger(`onRoute:${path}`);
    this.slots.onSlotRendered = (slot) => void this.trigger(`onSlot:${slot}`);
    this.ipc.beforeInvoke = (name) => this.trigger(`onIPC:${name}`);
    this.ipc.assertCallerPermission = (caller, permission, channel) => this.permissions.assert(caller, permission, `IPC "${channel}"`);
    this.events.on("**", (_p, ctx) => {
      if (!ctx.name.startsWith("plugin.")) void this.trigger(`onEvent:${ctx.name}`);
    }, { priority: 1000 });
    this.routes.onRouteRegistered = (route, owner) => {
      const menu = route.definition.meta?.menu;
      if (!menu || !owner) return;
      const meta = route.definition.meta!;
      return this.menus.register(
        {
          id: `route:${route.fullPath}`,
          location: menu.location ?? "sidebar",
          label: menu.label ?? meta.title ?? route.fullPath,
          icon: meta.icon,
          path: route.fullPath,
          order: menu.order,
          group: menu.group,
        },
        owner,
      );
    };
  }

  /**
   * Before a plugin is active, its statically declared commands/menus (manifest `contributes`) are visible
   * as lightweight proxies: using one activates the plugin on demand. Replaced by the real registrations on activate.
   */
  private installLazyProxies(rec: PluginRecord): void {
    if (rec.lazy.length) return;
    const c = rec.manifest.contributes ?? {};
    const owner = rec.id;
    for (const cmd of c.commands ?? []) {
      if (this.commands.has(cmd.id)) continue;
      rec.lazy.push(
        this.commands.register(
          {
            id: cmd.id,
            title: cmd.title,
            category: cmd.category,
            execute: async (...args: unknown[]) => {
              await this.activate(owner);
              return this.commands.execute(cmd.id, ...args);
            },
          },
          `${owner}#lazy`,
        ),
      );
    }
    for (const m of c.menus ?? []) {
      if (this.menus.has(`${m.location}:${m.id}`)) continue;
      rec.lazy.push(this.menus.register({ id: m.id, location: m.location, label: m.label, command: m.command }, `${owner}#lazy`));
    }
  }

  private removeLazyProxies(rec: PluginRecord): void {
    for (const d of rec.lazy.splice(0)) d.dispose();
  }

  /* ------------------------------------------------- declarative contributions */

  private async applyDeclarative(rec: PluginRecord): Promise<void> {
    const def = rec.definition!;
    const ctx = rec.context!;
    const renderer = this.runtime === "renderer";
    const main = this.runtime === "main";

    for (const [id, component] of Object.entries(def.layouts ?? {})) if (renderer) ctx.routes.registerLayout(id, component);
    if (renderer) for (const r of def.routes ?? []) ctx.routes.register(r);
    for (const c of def.commands ?? []) ctx.commands.register(c);
    for (const m of def.menus ?? []) ctx.menus.register(m);
    for (const h of def.hooks ?? []) ctx.hooks.use(h.name, h.handler, { priority: h.priority });
    const services = typeof def.services === "function" ? def.services(ctx) : def.services;
    for (const [name, impl] of Object.entries(services ?? {})) ctx.services.register(name, impl);
    if (main) for (const i of def.ipc ?? []) ctx.ipc.define(i);
    for (const e of def.events ?? []) ctx.events.on(e.name, e.handler, { priority: e.priority, once: e.once });
    if (renderer) for (const c of def.components ?? []) ctx.ui.register(c);
    if (renderer) {
      for (const x of def.extensions ?? []) {
        try {
          ctx.ui.extend(x.point, { ...x.contribution, priority: x.priority });
        } catch (e) {
          // A host that does not offer (or has not yet declared) an optional extension point must not break the plugin.
          ctx.logger.warn(`extension "${x.point}" skipped: ${errorMessage(e)}`);
        }
      }
    }
    if (renderer) for (const st of def.styles ?? []) ctx.styles.add(typeof st === "string" ? { css: st } : st);
    if (main) for (const [ns, members] of Object.entries(def.preload ?? {})) ctx.preload.expose(ns, members);
  }

  /* ------------------------------------------------------------- context */

  private createContext(rec: PluginRecord): PluginContext<any> {
    const id = rec.id;
    const store = () => rec.store; // looked up lazily: the store is replaced on teardown
    const track = <T extends Disposable>(d: T): T => store().add(d);
    const need = (permission: Permission, api: string): void => this.permissions.assert(id, permission, api);
    const logger = this.logs.logger(id);
    const renderer = this.runtime === "renderer";
    const bridge = this.opts.ipcBridge;

    const def = rec.definition!;
    const configDef = def.config ?? { schema: s.object({}) };
    const config = createPluginConfig(this.storageBackend, id, configDef, (next, prev) => {
      this.events.emit("plugin.config.changed", { id, next, prev }, id);
      this.changed();
    });
    rec.config = def.config ? config : undefined;
    const storage = createPluginStorage(this.storageBackend, id);
    const unsupported = (what: string): never => {
      throw new FrameworkError(`${what} is not available in the ${this.runtime} process`, "FLUX_UNSUPPORTED_RUNTIME", id);
    };

    const ctx: PluginContext<any> = {
      pluginId: id,
      manifest: rec.manifest,
      runtime: this.runtime,
      root: rec.source.root,
      logger,
      config,
      storage,
      state: this.stateOf(id),

      events: {
        on: (pattern, listener, opts) => (need("events", "events.on"), track(this.events.on(pattern, listener as any, opts))),
        once: (pattern, listener, opts) => (need("events", "events.once"), track(this.events.once(pattern, listener as any, opts))),
        emit: (name, payload, opts) => {
          need("events", "events.emit");
          const r = this.events.emit(name, payload, id);
          if (opts?.broadcast) this.opts.onBroadcastEvent?.(name, payload, id);
          return r;
        },
        emitAsync: (name, payload) => (need("events", "events.emitAsync"), this.events.emitAsync(name, payload, id)),
      },

      commands: {
        register: (c) => (need("commands", "commands.register"), track(this.commands.register(c, id))),
        execute: (cid, ...args) => (need("commands", "commands.execute"), this.commands.execute(cid, ...args)),
        list: () => this.commands.list(),
      },

      routes: {
        register: (r) => {
          need("routes", "routes.register");
          if (r.permission) need(r.permission, `route "${r.path}"`);
          return track(this.routes.register(r as any, id));
        },
        registerLayout: (lid, component) => (need("routes", "routes.registerLayout"), track(this.routes.registerLayout(lid, component))),
      },

      menus: { register: (m) => (need("menus", "menus.register"), track(this.menus.register(m, id))) },

      ui: {
        register: (c) => (need("ui", "ui.register"), track(this.slots.register(c, id, { strict: this.opts.strictSlots }))),
        extend: (point, contribution) => {
          need("ui", "ui.extend");
          const { mode, component, priority, ...data } = contribution;
          const parts: Disposable[] = [];
          try {
            if (component !== undefined) parts.push(this.slots.register({ slot: point, component, mode: mode ?? "append", priority }, id));
            if (Object.keys(data).length) parts.push(this.extensionPoints.contribute(point, data, id, priority ?? 0));
          } catch (e) {
            for (const p of parts) p.dispose();
            throw e;
          }
          return track(toDisposable(() => parts.forEach((p) => p.dispose())));
        },
      },

      ipc: {
        handle: ((a: any, handler: any, opts?: any) => {
          need("ipc", "ipc.handle");
          if (renderer) return unsupported("ipc.handle");
          return track(typeof a === "string" ? this.ipc.handle(a, handler, id, opts) : this.ipc.handle(a, handler, id));
        }) as PluginContext["ipc"]["handle"],
        define: (d) => {
          need("ipc", "ipc.define");
          if (renderer) return unsupported("ipc.define");
          return track(this.ipc.register(d, id));
        },
        on: (name, handler) => {
          need("ipc", "ipc.on");
          if (renderer) return track(bridge ? bridge.on(name, (p) => handler(p, { pluginId: id, caller: "host" })) : toDisposable(() => {}));
          return track(this.ipc.on(name, handler, id));
        },
        send: (channel, payload) => {
          need("ipc", "ipc.send");
          if (renderer) bridge?.send(channel, payload, id);
          else this.ipc.send(channel, payload);
        },
        invoke: ((a: any, input?: unknown) => {
          need("ipc", "ipc.invoke");
          const name = typeof a === "string" ? a : a.name;
          return renderer && bridge ? bridge.invoke(name, input, id) : this.ipc.invoke(name, input, { caller: id });
        }) as PluginContext["ipc"]["invoke"],
      },

      preload: {
        expose: (ns, members) => {
          need("ipc", "preload.expose");
          if (renderer) return unsupported("preload.expose");
          return track(this.preload.expose(ns, members, id));
        },
      },

      services: {
        register: (name, impl) => (need("services", "services.register"), track(this.services.register(name, impl, id))),
        get: (name) => (need("services", "services.get"), this.services.resolve(name)),
        getAsync: (name) => (need("services", "services.getAsync"), this.services.resolveAsync(name)),
      },

      hooks: {
        use: (name, handler, opts) => (need("hooks", "hooks.use"), track(this.hooks.use(name as any, handler as any, { ...opts, owner: id }))),
        run: (op, input, exec) => (need("hooks", "hooks.run"), this.hooks.run(op, input, exec)),
        filter: (name, value, extra) => (need("hooks", "hooks.filter"), this.hooks.filter(name, value, extra)),
      },

      notifications: { push: (n) => (need("notifications", "notifications.push"), this.notifications.push(n, id)) },

      styles: { add: (st) => (need("styles", "styles.add"), track(this.styles.register(st, id))) },

      host: {
        has: (name) => this.hostApis.has(name),
        api: <T>(name: string): T => {
          const p = this.hostApis.get(name);
          if (!p) throw new FrameworkError(`Host API "${name}" is not provided by this application`, "FLUX_UNKNOWN_HOST_API", id);
          if (p.permission) need(p.permission, `host API "${name}"`);
          return p.factory({ pluginId: id, root: rec.source.root, manifest: rec.manifest }) as T;
        },
      },

      permissions: {
        has: (p) => this.permissions.has(id, p),
        assert: (p) => this.permissions.assert(id, p),
        list: () => this.permissions.snapshot(id),
      },

      lifecycle: {
        get state() {
          return rec.state;
        },
        onDeactivate: (fn) => void rec.deactivators.push(fn),
        subscriptions: { add: (d) => track(d) },
      },
    };
    return ctx;
  }
}

/** `onRoute:/students/:id` style patterns: `:param` matches one segment, `*` matches the rest. */
export function routePatternMatches(pattern: string, path: string): boolean {
  const p = normalizePath(pattern).split("/").filter(Boolean);
  const t = normalizePath(path).split("/").filter(Boolean);
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg === "*") return true;
    if (t[i] === undefined) return false;
    if (seg.startsWith(":")) continue;
    if (seg !== t[i]) return false;
  }
  return p.length === t.length;
}
