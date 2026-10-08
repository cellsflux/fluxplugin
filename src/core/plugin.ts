import type { Disposable, Logger } from "./common.js";
import type { EventContext, EventListener, ListenerOptions, EmitResult } from "./events.js";
import type { AroundNext, HookContext, HookOptions } from "./hooks.js";
import type { IpcCallContext, IpcContract, IpcDefinition, IpcHandler, PreloadMemberInput } from "./ipc.js";
import type { Permission, PluginManifest } from "./manifest.js";
import type { CommandDefinition, MenuItemDefinition } from "./registry.js";
import type { RouteDefinition } from "./routes.js";
import type { Schema } from "./schema.js";
import type { SlotContribution } from "./slots.js";
import type { ConfigDefinition, PluginConfig, PluginState_, PluginStorage } from "./storage.js";
import type { StyleInput } from "./styles.js";

export type Runtime = "main" | "renderer";

export type PluginState =
  | "discovered"
  | "validated"
  | "loaded"
  | "initialized"
  | "activated"
  | "ready"
  | "deactivated"
  | "unloaded"
  | "disabled"
  | "error";

export type MenuInput = Omit<MenuItemDefinition, "id" | "location"> & { id: string; location: MenuItemDefinition["location"] };

export interface PluginContext<Cfg extends Record<string, any> = Record<string, any>> {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly runtime: Runtime;
  /** Absolute directory of the plugin on disk (main process only). */
  readonly root: string | undefined;
  readonly logger: Logger;
  readonly config: PluginConfig<Cfg>;
  readonly storage: PluginStorage;
  /** Volatile reactive state shared with `usePluginState` in React. */
  readonly state: PluginState_;

  readonly events: {
    on<T = unknown>(pattern: string, listener: EventListener<T>, opts?: ListenerOptions): Disposable;
    once<T = unknown>(pattern: string, listener: EventListener<T>, opts?: Omit<ListenerOptions, "once">): Disposable;
    emit(name: string, payload?: unknown, opts?: { broadcast?: boolean }): EmitResult;
    emitAsync(name: string, payload?: unknown): Promise<EmitResult>;
  };
  readonly commands: {
    register(command: CommandDefinition<any[], any>): Disposable;
    execute<R = unknown>(id: string, ...args: unknown[]): Promise<R>;
    list(): CommandDefinition[];
  };
  readonly routes: {
    register<C = unknown>(route: RouteDefinition<C>): Disposable;
    registerLayout<C = unknown>(id: string, component: C): Disposable;
  };
  readonly menus: { register(item: MenuInput): Disposable };
  readonly ui: {
    /** Contributes a component to a host-defined slot. */
    register<C = unknown>(contribution: SlotContribution<C>): Disposable;
    /**
     * Extends a host extension point. With `component` it behaves like a slot contribution
     * (`ui.extend("user.profile", { mode: "append", component })`); other keys are validated data contributions.
     */
    extend(point: string, contribution: Record<string, unknown> & { mode?: SlotContribution["mode"]; component?: unknown; priority?: number }): Disposable;
  };
  readonly ipc: {
    handle<I, O>(contract: IpcContract<I, O>, handler: IpcHandler<I, O>): Disposable;
    handle<I = unknown, O = unknown>(name: string, handler: IpcHandler<I, O>, opts?: { input?: Schema<I>; output?: Schema<O>; permission?: Permission }): Disposable;
    define(def: IpcDefinition<any, any>): Disposable;
    on(name: string, handler: (payload: unknown, ctx: IpcCallContext) => void): Disposable;
    /** Main → renderer push (main) / renderer → main fire-and-forget (renderer). */
    send(channel: string, payload?: unknown): void;
    invoke<I, O>(contract: IpcContract<I, O>, input: I): Promise<O>;
    invoke<O = unknown>(name: string, input?: unknown): Promise<O>;
  };
  readonly preload: {
    expose(namespace: string, members: Record<string, PreloadMemberInput>): Disposable;
  };
  readonly services: {
    register<T>(name: string, implementation: T): Disposable;
    get<T = unknown>(name: string): T | undefined;
    getAsync<T = unknown>(name: string): Promise<T>;
  };
  readonly hooks: {
    use(name: string, handler: (...args: any[]) => any, opts?: Omit<HookOptions, "owner">): Disposable;
    run<I, R>(operation: string, input: I, exec: (input: I, ctx: HookContext<I, R>) => R | Promise<R>): Promise<R>;
    filter<V, X = unknown>(name: string, value: V, extra?: X): Promise<V>;
  };
  readonly styles: { add(style: StyleInput): Disposable };
  /** Bell + toasts in the host UI (permission "notifications"). */
  readonly notifications: { push(n: import("./notifications.js").NotificationInput): { id: string; dismiss(): void } };
  /** Controlled APIs exposed by the host (see `host.provide`), permission-checked per plugin. */
  readonly host: { api<T = unknown>(name: string): T; has(name: string): boolean };
  readonly permissions: {
    has(permission: Permission): boolean;
    assert(permission: Permission): void;
    list(): { declared: Permission[]; granted: Permission[]; denied: Permission[] };
  };
  readonly lifecycle: {
    readonly state: PluginState;
    /** Registers cleanup executed on deactivate (in reverse order). */
    onDeactivate(fn: () => void | Promise<void>): void;
    /** Anything pushed here is disposed automatically when the plugin deactivates. */
    readonly subscriptions: { add<T extends Disposable>(d: T): T };
  };
}

type Ctx<Cfg extends Record<string, any>> = PluginContext<Cfg>;

export interface PluginDefinition<Cfg extends Record<string, any> = Record<string, any>> {
  /** Optional: when present it must match the manifest id. */
  id?: string;
  name?: string;
  version?: string;

  /** Configuration schema; `context.config` and the auto-generated settings form use it. */
  config?: ConfigDefinition<Cfg>;

  /* ---- declarative contributions (registered automatically on activation) ---- */
  routes?: RouteDefinition<any>[];
  layouts?: Record<string, unknown>;
  commands?: CommandDefinition<any[], any>[];
  menus?: MenuInput[];
  hooks?: { name: string; handler: (...args: any[]) => any; priority?: number }[];
  /** Service name → implementation, or a factory receiving the context. */
  services?: Record<string, unknown> | ((ctx: Ctx<Cfg>) => Record<string, unknown>);
  ipc?: IpcDefinition<any, any>[];
  events?: { name: string; handler: EventListener<any>; priority?: number; once?: boolean }[];
  /** Slot contributions. */
  components?: SlotContribution<any>[];
  /** Extension point contributions. */
  extensions?: { point: string; contribution: Record<string, unknown>; priority?: number }[];
  styles?: (string | StyleInput)[];
  /** Renderer-visible APIs: `{ analytics: { getStats: "analytics.getStats" } }`. */
  preload?: Record<string, Record<string, PreloadMemberInput>>;

  /* ---- lifecycle ---- */
  onLoad?(ctx: Ctx<Cfg>): void | Promise<void>;
  onInitialize?(ctx: Ctx<Cfg>): void | Promise<void>;
  /** Imperative registration point (alias: `activate`). Runs after declarative contributions are registered. */
  onActivate?(ctx: Ctx<Cfg>): void | Promise<void>;
  activate?(ctx: Ctx<Cfg>): void | Promise<void>;
  onReady?(ctx: Ctx<Cfg>): void | Promise<void>;
  onDeactivate?(ctx: Ctx<Cfg>): void | Promise<void>;
  deactivate?(ctx: Ctx<Cfg>): void | Promise<void>;
  onUnload?(ctx: Ctx<Cfg>): void | Promise<void>;
}

/** Identity helper giving full type inference for plugin definitions (and config types). */
export function definePlugin<Cfg extends Record<string, any> = Record<string, any>>(def: PluginDefinition<Cfg>): PluginDefinition<Cfg> {
  return def;
}
export const defineRoute = <C = unknown>(r: RouteDefinition<C>): RouteDefinition<C> => r;
export const defineCommand = <A extends unknown[] = any[], R = unknown>(c: CommandDefinition<A, R>): CommandDefinition<A, R> => c;
export const defineService = <T extends Record<string, unknown>>(name: string, impl: T): { name: string; implementation: T } => ({ name, implementation: impl });
export const defineHook = <I = any, R = any>(
  name: string,
  handler: (ctx: HookContext<I, R>, next: AroundNext<R>) => any,
  priority?: number,
): { name: string; handler: typeof handler; priority?: number } => ({ name, handler, priority });
export const defineEvent = <T = unknown>(
  name: string,
  handler: EventListener<T>,
  opts: ListenerOptions = {},
): { name: string; handler: EventListener<T>; priority?: number; once?: boolean } => ({ name, handler, ...opts });
export const defineComponent = <C = unknown>(c: SlotContribution<C>): SlotContribution<C> => c;
export const defineMenu = (m: MenuInput): MenuInput => m;

export type { EventContext };

/** Information about a plugin as exposed to UIs (manager screens, CLI...). Serializable. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  state: PluginState;
  enabled: boolean;
  runtime: Runtime;
  permissions: { declared: Permission[]; granted: Permission[]; denied: Permission[] };
  dependencies: Record<string, string>;
  dependents: string[];
  activationEvents: string[];
  contributes: PluginManifest["contributes"];
  error?: { message: string; phase: string; time: number };
  crashes: number;
  hasConfig: boolean;
  root?: string;
  origin?: string;
  warnings: string[];
}
