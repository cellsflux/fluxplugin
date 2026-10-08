import { FrameworkError, errorMessage, toDisposable, type Disposable } from "./common.js";
import type { Permission } from "./manifest.js";
import { ValidationError, type Infer, type Schema } from "./schema.js";
import { Registry } from "./registry.js";

/* ---------------------------------------------------------------- contracts */

/** A shared description of one IPC endpoint. Import it from both main and renderer code to get end-to-end types. */
export interface IpcContract<I = unknown, O = unknown> {
  readonly name: string;
  readonly input?: Schema<I>;
  readonly output?: Schema<O>;
  /** Permission the *calling* plugin must hold when the call originates from a plugin. */
  readonly permission?: Permission;
  /** Phantom fields carrying the types (never set at runtime). */
  readonly _in?: I;
  readonly _out?: O;
}

export interface IpcCallContext {
  /** Plugin that owns the handler. */
  pluginId: string;
  /** Plugin (or `host`) that issued the call. */
  caller: string;
  /** Opaque identifier of the sender (e.g. webContents id) provided by the transport. */
  senderId?: number | string;
}

export type IpcHandler<I, O> = (input: I, ctx: IpcCallContext) => O | Promise<O>;

export interface IpcDefinition<I = unknown, O = unknown> extends IpcContract<I, O> {
  readonly handler: IpcHandler<I, O>;
  readonly contract: IpcContract<I, O>;
}

export function defineIpcContract<I = void, O = unknown>(c: {
  name: string;
  input?: Schema<I>;
  output?: Schema<O>;
  permission?: Permission;
}): IpcContract<I, O> {
  return Object.freeze({ ...c });
}

/** Declares an IPC endpoint with its handler. Types of `handler` are inferred from the schemas. */
export function defineIPC<IS extends Schema<any> | undefined = undefined, OS extends Schema<any> | undefined = undefined>(def: {
  name: string;
  input?: IS;
  output?: OS;
  permission?: Permission;
  handler: IpcHandler<IS extends Schema<any> ? Infer<IS> : void, OS extends Schema<any> ? Infer<OS> : unknown>;
}): IpcDefinition<IS extends Schema<any> ? Infer<IS> : void, OS extends Schema<any> ? Infer<OS> : unknown> {
  type I = IS extends Schema<any> ? Infer<IS> : void;
  type O = OS extends Schema<any> ? Infer<OS> : unknown;
  const contract: IpcContract<I, O> = Object.freeze({
    name: def.name,
    input: def.input as Schema<I> | undefined,
    output: def.output as Schema<O> | undefined,
    permission: def.permission,
  });
  return { ...contract, handler: def.handler as IpcHandler<I, O>, contract };
}

/* ---------------------------------------------------------------- transport */

export type Unsubscribe = () => void;

/** What the main-side registry needs from the environment to talk to renderers. */
export interface IpcTransport {
  /** Sends an event from main to every renderer (or one target when `target` is given). */
  broadcast(channel: string, payload: unknown, target?: number | string): void;
}

/* ---------------------------------------------------------------- registry */

interface HandlerEntry {
  name: string;
  handler: IpcHandler<any, any>;
  input?: Schema<any>;
  output?: Schema<any>;
  permission?: Permission;
  owner: string;
}

const RESERVED = /^flux\./;

export interface InvokeOptions {
  caller?: string;
  senderId?: number | string;
}

export class IpcError extends FrameworkError {
  constructor(
    message: string,
    code: string,
    public readonly channel: string,
  ) {
    super(message, code);
  }
}

/** Serializable error shape sent back to renderers (stack traces never cross the boundary). */
export interface IpcErrorPayload {
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
}

export function serializeError(e: unknown): IpcErrorPayload {
  if (e instanceof ValidationError) return { code: "FLUX_VALIDATION", message: e.message, issues: e.issues };
  if (e instanceof FrameworkError) return { code: e.code, message: e.message };
  return { code: "FLUX_HANDLER_ERROR", message: errorMessage(e) };
}

export class IpcRegistry extends Registry<HandlerEntry> {
  private oneWay = new Map<string, Set<{ fn: (payload: unknown, ctx: IpcCallContext) => void; owner: string }>>();
  private transport: IpcTransport | undefined;
  /** Hook for the manager: ensures the owner plugin is active (`onIPC:<name>`) and checks caller permissions. */
  beforeInvoke?: (name: string, opts: InvokeOptions) => Promise<void>;
  /** Permission check provided by the manager. */
  assertCallerPermission?: (caller: string, permission: Permission, channel: string) => void;
  /** Observer used for diagnostics. */
  onCall?: (info: { name: string; owner: string; caller: string; ms: number; error?: unknown }) => void;

  constructor() {
    super("IPC handler");
  }

  setTransport(t: IpcTransport | undefined): void {
    this.transport = t;
  }

  handle<I, O>(def: IpcContract<I, O>, handler: IpcHandler<I, O>, owner: string): Disposable;
  handle<I = unknown, O = unknown>(name: string, handler: IpcHandler<I, O>, owner: string, opts?: { input?: Schema<I>; output?: Schema<O>; permission?: Permission }): Disposable;
  handle(a: string | IpcContract<any, any>, handler: IpcHandler<any, any>, owner: string, opts: { input?: Schema<any>; output?: Schema<any>; permission?: Permission } = {}): Disposable {
    const c = typeof a === "string" ? { name: a, ...opts } : a;
    if (RESERVED.test(c.name) && owner !== "host") {
      throw new FrameworkError(`IPC names starting with "flux." are reserved for the framework`, "FLUX_RESERVED", owner);
    }
    return this.add(c.name, { name: c.name, handler, input: c.input, output: c.output, permission: c.permission, owner }, owner);
  }

  /** Registers a full `IpcDefinition` (contract + handler). */
  register(def: IpcDefinition<any, any>, owner: string): Disposable {
    return this.handle(def.contract, def.handler, owner);
  }

  /** Dispatches a call: validate input → permission → handler → validate output. */
  async invoke<O = unknown>(name: string, input: unknown, opts: InvokeOptions = {}): Promise<O> {
    if (!this.has(name)) await this.beforeInvoke?.(name, opts);
    const entry = this.table.get(name)?.item;
    if (!entry) throw new IpcError(`No handler registered for "${name}"`, "FLUX_NO_HANDLER", name);
    const caller = opts.caller ?? "host";
    const started = Date.now();
    try {
      if (entry.permission && caller !== "host") this.assertCallerPermission?.(caller, entry.permission, name);
      let value = input;
      if (entry.input) {
        const r = entry.input.parse(input);
        if (!r.ok) throw new ValidationError(r.issues, `input of "${name}"`);
        value = r.value;
      }
      const out = await entry.handler(value, { pluginId: entry.owner, caller, senderId: opts.senderId });
      if (entry.output) {
        const r = entry.output.parse(out);
        if (!r.ok) throw new ValidationError(r.issues, `output of "${name}"`);
        this.onCall?.({ name, owner: entry.owner, caller, ms: Date.now() - started });
        return r.value as O;
      }
      this.onCall?.({ name, owner: entry.owner, caller, ms: Date.now() - started });
      return out as O;
    } catch (e) {
      this.onCall?.({ name, owner: entry.owner, caller, ms: Date.now() - started, error: e });
      throw e;
    }
  }

  /** Fire-and-forget messages from renderer/other plugins to main (`ipc.on`). */
  on(name: string, fn: (payload: unknown, ctx: IpcCallContext) => void, owner: string): Disposable {
    let set = this.oneWay.get(name);
    if (!set) this.oneWay.set(name, (set = new Set()));
    const entry = { fn, owner };
    set.add(entry);
    return toDisposable(() => set!.delete(entry));
  }

  /** Delivers a one-way message to main-side listeners. */
  dispatch(name: string, payload: unknown, opts: InvokeOptions = {}): number {
    const set = this.oneWay.get(name);
    if (!set) return 0;
    let n = 0;
    for (const l of [...set]) {
      try {
        l.fn(payload, { pluginId: l.owner, caller: opts.caller ?? "host", senderId: opts.senderId });
        n++;
      } catch {
        /* listener failures are isolated */
      }
    }
    return n;
  }

  /** Main → renderer push. */
  send(channel: string, payload: unknown, target?: number | string): void {
    this.transport?.broadcast(channel, payload, target);
  }

  removeListenersByOwner(owner: string): void {
    for (const set of this.oneWay.values()) for (const l of [...set]) if (l.owner === owner) set.delete(l);
  }
}

/* ------------------------------------------------- preload API declarations */

export type PreloadMember =
  | { kind: "invoke"; channel: string }
  | { kind: "send"; channel: string }
  | { kind: "event"; channel: string };

export type PreloadApiSpec = Record<string, PreloadMember>;
export type PreloadMemberInput = string | PreloadMember;

/** Helpers mirroring the declarative shape so plugin code reads naturally. */
export const preloadMember = {
  invoke: (channel: string): PreloadMember => ({ kind: "invoke", channel }),
  send: (channel: string): PreloadMember => ({ kind: "send", channel }),
  event: (channel: string): PreloadMember => ({ kind: "event", channel }),
};

export interface PreloadExposure {
  id: string;
  namespace: string;
  spec: PreloadApiSpec;
  owner: string;
}

const NAMESPACE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_NS = new Set(["__proto__", "constructor", "prototype", "flux", "__fluxplugin"]);

/**
 * Registry of the APIs plugins want available to the renderer under `window.plugins.<namespace>`.
 * The sandboxed preload cannot execute plugin code, so exposures are *data*: each member maps to an IPC
 * channel. The generic preload bridge (see `fluxplugin/preload`) turns them into callable functions.
 */
export class PreloadRegistry extends Registry<PreloadExposure> {
  constructor() {
    super("Preload API");
  }

  expose(namespace: string, members: Record<string, PreloadMemberInput>, owner: string): Disposable {
    if (!NAMESPACE_RE.test(namespace) || FORBIDDEN_NS.has(namespace)) {
      throw new FrameworkError(`Invalid preload namespace "${namespace}"`, "FLUX_INVALID_NAMESPACE", owner);
    }
    const spec: PreloadApiSpec = {};
    for (const [key, m] of Object.entries(members)) {
      if (!NAMESPACE_RE.test(key) || FORBIDDEN_NS.has(key)) {
        throw new FrameworkError(`Invalid preload member "${namespace}.${key}"`, "FLUX_INVALID_NAMESPACE", owner);
      }
      spec[key] = typeof m === "string" ? { kind: "invoke", channel: m } : m;
    }
    return this.add(namespace, { id: namespace, namespace, spec, owner }, owner);
  }

  /** JSON-serializable manifest sent to the preload bridge. */
  manifest(): Record<string, PreloadApiSpec> {
    const out: Record<string, PreloadApiSpec> = {};
    for (const e of this.list()) out[e.namespace] = e.spec;
    return out;
  }
}

/** Augment in your host or plugin to get typed access to `window.plugins`: `interface PluginApis { analytics: AnalyticsApi }` */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PluginApis {}
