import { toDisposable, type Disposable } from "./common.js";
import { ValidationError, type Schema } from "./schema.js";

/** Persistence backend: one JSON document per namespace (= plugin id). */
export interface StorageBackend {
  read(namespace: string): Promise<Record<string, unknown>>;
  write(namespace: string, data: Record<string, unknown>): Promise<void>;
  remove?(namespace: string): Promise<void>;
}

export class MemoryStorageBackend implements StorageBackend {
  private data = new Map<string, Record<string, unknown>>();
  async read(ns: string): Promise<Record<string, unknown>> {
    return structuredClone(this.data.get(ns) ?? {});
  }
  async write(ns: string, data: Record<string, unknown>): Promise<void> {
    this.data.set(ns, structuredClone(data));
  }
  async remove(ns: string): Promise<void> {
    this.data.delete(ns);
  }
}

export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T>(key: string, fallback: T): Promise<T>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

/** Keys reserved for the framework inside each namespace. */
const CONFIG_KEY = "__fluxplugin_config__";

/**
 * Storage scoped to a single plugin. Writes are serialized per namespace so concurrent `set` calls never
 * lose updates, and values are cloned (structured clone) so callers cannot mutate stored state by reference.
 */
export function createPluginStorage(backend: StorageBackend, namespace: string): PluginStorage {
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const guard = (key: string): void => {
    if (typeof key !== "string" || key.length === 0) throw new Error("Storage key must be a non-empty string");
    if (key === CONFIG_KEY || key === "__proto__") throw new Error(`Storage key "${key}" is reserved`);
  };
  return {
    async get(key: string, fallback?: unknown) {
      guard(key);
      const data = await exclusive(() => backend.read(namespace));
      return Object.prototype.hasOwnProperty.call(data, key) ? structuredClone(data[key]) : fallback;
    },
    async set(key, value) {
      guard(key);
      await exclusive(async () => {
        const data = await backend.read(namespace);
        data[key] = structuredClone(value);
        await backend.write(namespace, data);
      });
    },
    async delete(key) {
      guard(key);
      await exclusive(async () => {
        const data = await backend.read(namespace);
        delete data[key];
        await backend.write(namespace, data);
      });
    },
    async keys() {
      const data = await exclusive(() => backend.read(namespace));
      return Object.keys(data).filter((k) => k !== CONFIG_KEY);
    },
    async clear() {
      await exclusive(async () => {
        const data = await backend.read(namespace);
        await backend.write(namespace, CONFIG_KEY in data ? { [CONFIG_KEY]: data[CONFIG_KEY] } : {});
      });
    },
  } as PluginStorage;
}

/* ------------------------------------------------------------ configuration */

export interface ConfigDefinition<T extends Record<string, any> = Record<string, any>> {
  schema: Schema<T>;
  /** Current schema version. Stored configs with a lower version go through `migrate`. */
  version?: number;
  migrate?: (old: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
}

export interface PluginConfig<T extends Record<string, any> = Record<string, any>> {
  /** Loads (and migrates/validates) the configuration; always resolves with a fully defaulted object. */
  get(): Promise<T>;
  /** Merges a partial update, validates the result and persists it. Rejects with `ValidationError`. */
  set(patch: Partial<T>): Promise<T>;
  reset(): Promise<T>;
  onChange(listener: (next: T, prev: T) => void): Disposable;
  /** JSON-schema-like description for building settings forms automatically. */
  describe(): ReturnType<Schema<T>["describe"]>;
}

interface StoredConfig {
  version: number;
  values: Record<string, unknown>;
}

export function createPluginConfig<T extends Record<string, any>>(
  backend: StorageBackend,
  namespace: string,
  def: ConfigDefinition<T>,
  onChanged?: (next: T, prev: T) => void,
): PluginConfig<T> {
  const version = def.version ?? 1;
  const listeners = new Set<(next: T, prev: T) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const defaults = (): T => {
    const r = def.schema.parse({});
    if (!r.ok) throw new ValidationError(r.issues, `default configuration of "${namespace}" (every field needs a default or to be optional)`);
    return r.value;
  };

  const load = async (): Promise<T> => {
    const data = await backend.read(namespace);
    const stored = data[CONFIG_KEY] as StoredConfig | undefined;
    if (!stored) return defaults();
    let values = stored.values ?? {};
    if (stored.version < version && def.migrate) values = def.migrate(values, stored.version);
    const r = def.schema.parse(values);
    if (r.ok) return r.value;
    // Stored data is no longer valid for the schema: fall back to defaults rather than crash the plugin.
    return defaults();
  };

  const save = async (values: T): Promise<void> => {
    const data = await backend.read(namespace);
    data[CONFIG_KEY] = { version, values } satisfies StoredConfig;
    await backend.write(namespace, data);
  };

  const emit = (next: T, prev: T): void => {
    onChanged?.(next, prev);
    for (const l of [...listeners]) {
      try {
        l(next, prev);
      } catch {
        /* ignore listener errors */
      }
    }
  };

  return {
    get: () => exclusive(load),
    set: (patch) =>
      exclusive(async () => {
        const prev = await load();
        const r = def.schema.parse({ ...prev, ...patch });
        if (!r.ok) throw new ValidationError(r.issues, `configuration of "${namespace}"`);
        await save(r.value);
        emit(r.value, prev);
        return r.value;
      }),
    reset: () =>
      exclusive(async () => {
        const prev = await load();
        const next = defaults();
        await save(next);
        emit(next, prev);
        return next;
      }),
    onChange(l) {
      listeners.add(l);
      return toDisposable(() => listeners.delete(l));
    },
    describe: () => def.schema.describe(),
  };
}

/* -------------------------------------------------------------------- state */

export interface PluginState_ {
  get<T = unknown>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  /** Subscribes to changes of one key (or every key when omitted). */
  subscribe(listener: (key: string, value: unknown) => void, key?: string): Disposable;
  snapshot(): Record<string, unknown>;
}

/** Volatile, reactive per-plugin state (lives as long as the plugin runtime; use `storage` for persistence). */
export function createPluginState(): PluginState_ {
  const data = new Map<string, unknown>();
  const listeners = new Set<{ fn: (k: string, v: unknown) => void; key?: string }>();
  const notify = (k: string, v: unknown): void => {
    for (const l of [...listeners]) {
      if (l.key !== undefined && l.key !== k) continue;
      try {
        l.fn(k, v);
      } catch {
        /* ignore */
      }
    }
  };
  return {
    get: ((key: string, fallback?: unknown) => (data.has(key) ? data.get(key) : fallback)) as PluginState_["get"],
    set(key, value) {
      if (Object.is(data.get(key), value) && data.has(key)) return;
      data.set(key, value);
      notify(key, value);
    },
    delete(key) {
      if (data.delete(key)) notify(key, undefined);
    },
    subscribe(fn, key) {
      const l = { fn, key };
      listeners.add(l);
      return toDisposable(() => listeners.delete(l));
    },
    snapshot: () => Object.fromEntries(data),
  };
}
