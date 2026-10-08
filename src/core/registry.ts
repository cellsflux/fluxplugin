import { FrameworkError, toDisposable, type Disposable } from "./common.js";
import type { MenuLocation } from "./manifest.js";

/** Base registry with ownership tracking, change notification and a version counter (for `useSyncExternalStore`). */
export class Registry<T> {
  protected table = new Map<string, { item: T; owner?: string }>();
  private subscribers = new Set<() => void>();
  private _version = 0;

  constructor(protected readonly kind: string) {}

  get version(): number {
    return this._version;
  }

  protected add(key: string, item: T, owner?: string): Disposable {
    if (this.table.has(key)) {
      const existing = this.table.get(key)!;
      throw new FrameworkError(
        `${this.kind} "${key}" is already registered${existing.owner ? ` by "${existing.owner}"` : ""}`,
        "FLUX_DUPLICATE",
        owner,
      );
    }
    const entry = { item, owner };
    this.table.set(key, entry);
    this.changed();
    return toDisposable(() => {
      if (this.table.get(key) === entry) {
        this.table.delete(key);
        this.changed();
      }
    });
  }

  has(key: string): boolean {
    return this.table.has(key);
  }

  get(key: string): T | undefined {
    return this.table.get(key)?.item;
  }

  ownerOf(key: string): string | undefined {
    return this.table.get(key)?.owner;
  }

  list(): T[] {
    return [...this.table.values()].map((e) => e.item);
  }

  listByOwner(owner: string): T[] {
    return [...this.table.values()].filter((e) => e.owner === owner).map((e) => e.item);
  }

  unregisterByOwner(owner: string): number {
    let n = 0;
    for (const [k, e] of this.table) {
      if (e.owner === owner) {
        this.table.delete(k);
        n++;
      }
    }
    if (n) this.changed();
    return n;
  }

  clear(): void {
    this.table.clear();
    this.changed();
  }

  /** Subscribes to any change. Returns an unsubscribe function compatible with `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => void this.subscribers.delete(listener);
  };

  protected changed(): void {
    this._version++;
    for (const l of [...this.subscribers]) {
      try {
        l();
      } catch {
        /* listener errors must not break registries */
      }
    }
  }
}

/* ------------------------------------------------------------------ commands */

export interface CommandDefinition<A extends unknown[] = any[], R = unknown> {
  id: string;
  title: string;
  category?: string;
  description?: string;
  /** Keyboard shortcut, e.g. `Mod+Shift+A` (`Mod` = Ctrl on Windows/Linux, Cmd on macOS). */
  keybinding?: string;
  icon?: unknown;
  /** Evaluated by hosts to hide or disable the command in menus / palette. */
  when?: () => boolean;
  execute: (...args: A) => R | Promise<R>;
}

export class CommandRegistry extends Registry<CommandDefinition> {
  /** Set by the plugin manager: activates plugins that declared `onCommand:<id>` before execution. */
  beforeExecute?: (id: string) => Promise<void>;
  /** Observer used for diagnostics / hooks. */
  onExecuted?: (id: string, error?: unknown) => void;

  constructor() {
    super("Command");
  }

  register(command: CommandDefinition<any[], any>, owner?: string): Disposable {
    return this.add(command.id, command, owner);
  }

  async execute<R = unknown>(id: string, ...args: unknown[]): Promise<R> {
    if (!this.has(id)) await this.beforeExecute?.(id);
    const cmd = this.get(id);
    if (!cmd) throw new FrameworkError(`Unknown command "${id}"`, "FLUX_UNKNOWN_COMMAND");
    if (cmd.when && !cmd.when()) throw new FrameworkError(`Command "${id}" is not available right now`, "FLUX_COMMAND_DISABLED");
    try {
      const r = (await cmd.execute(...args)) as R;
      this.onExecuted?.(id);
      return r;
    } catch (e) {
      this.onExecuted?.(id, e);
      throw e;
    }
  }

  /** Commands sorted for display in a palette. */
  palette(query = ""): CommandDefinition[] {
    const q = query.trim().toLowerCase();
    return this.list()
      .filter((c) => (!c.when || c.when()) && (!q || `${c.category ?? ""} ${c.title} ${c.id}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.title.localeCompare(b.title));
  }

  /** Finds the command bound to a keyboard shortcut. */
  byKeybinding(binding: string): CommandDefinition | undefined {
    const norm = (b: string) => b.toLowerCase().replace(/\s+/g, "").split("+").sort().join("+");
    return this.list().find((c) => c.keybinding && norm(c.keybinding) === norm(binding));
  }
}

/* --------------------------------------------------------------------- menus */

export interface MenuItemDefinition {
  id: string;
  location: MenuLocation;
  label: string;
  icon?: unknown;
  /** Command executed on click. */
  command?: string;
  args?: unknown[];
  /** Visual grouping and ordering inside the location. */
  group?: string;
  order?: number;
  when?: () => boolean;
  separator?: boolean;
  children?: Omit<MenuItemDefinition, "location">[];
  /** Short label shown as a badge. */
  badge?: string | number;
  /** Route path, for sidebar entries that navigate without a command. */
  path?: string;
}

export class MenuRegistry extends Registry<MenuItemDefinition> {
  constructor() {
    super("Menu item");
  }

  register(item: MenuItemDefinition, owner?: string): Disposable {
    return this.add(`${item.location}:${item.id}`, item, owner);
  }

  items(location: MenuLocation): MenuItemDefinition[] {
    return this.list()
      .filter((m) => m.location === location && (!m.when || m.when()))
      .sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
  }
}

/* ------------------------------------------------------------------ services */

export interface ServiceEntry<T = unknown> {
  id: string;
  implementation: T;
}

export class ServiceRegistry extends Registry<ServiceEntry> {
  /** Set by the plugin manager: activates plugins declaring `onService:<name>` on first lookup. */
  beforeResolve?: (name: string) => Promise<void>;

  constructor() {
    super("Service");
  }

  register<T>(name: string, implementation: T, owner?: string): Disposable {
    return this.add(name, { id: name, implementation }, owner);
  }

  /** Synchronous lookup — returns undefined when the providing plugin is not active. */
  resolve<T = unknown>(name: string): T | undefined {
    return this.get(name)?.implementation as T | undefined;
  }

  /** Looks a service up, activating its provider lazily if necessary. */
  async resolveAsync<T = unknown>(name: string): Promise<T> {
    if (!this.has(name)) await this.beforeResolve?.(name);
    const s = this.get(name);
    if (!s) throw new FrameworkError(`Service "${name}" is not available`, "FLUX_UNKNOWN_SERVICE");
    return s.implementation as T;
  }
}
