export interface Disposable {
  dispose(): void;
}

export const toDisposable = (fn: () => void): Disposable => {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      fn();
    },
  };
};

/** Collects disposables so that everything a plugin registered is removed when the plugin deactivates. */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(d: T): T {
    if (this.disposed) d.dispose();
    else this.items.push(d);
    return d;
  }

  get size(): number {
    return this.items.length;
  }

  dispose(): void {
    this.disposed = true;
    const items = this.items.splice(0).reverse();
    for (const d of items) {
      try {
        d.dispose();
      } catch {
        /* a failing disposer must never prevent the others from running */
      }
    }
  }

  /** Re-arms the store so it can be reused after a deactivate/activate cycle. */
  reset(): void {
    this.dispose();
    this.disposed = false;
  }
}

export class FrameworkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly pluginId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class PermissionDeniedError extends FrameworkError {
  constructor(pluginId: string, public readonly permission: string, api: string) {
    super(`Plugin "${pluginId}" is not allowed to use ${api} (missing permission "${permission}")`, "FLUX_PERMISSION_DENIED", pluginId);
  }
}

export class LifecycleError extends FrameworkError {
  constructor(pluginId: string, public readonly phase: string, message: string, cause?: unknown) {
    super(`[${pluginId}] ${phase}: ${message}`, "FLUX_LIFECYCLE", pluginId, { cause });
  }
}

export class TimeoutError extends FrameworkError {
  constructor(what: string, ms: number, pluginId?: string) {
    super(`${what} timed out after ${ms}ms`, "FLUX_TIMEOUT", pluginId);
  }
}

export class HookCancelledError extends FrameworkError {
  constructor(public readonly operation: string, public readonly reason?: string) {
    super(`Operation "${operation}" was cancelled by a hook${reason ? `: ${reason}` : ""}`, "FLUX_HOOK_CANCELLED");
  }
}

export function withTimeout<T>(p: Promise<T> | T, ms: number, what: string, pluginId?: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(p);
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(what, ms, pluginId)), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  level: LogLevel;
  source: string;
  message: string;
  time: number;
  data?: unknown;
}
export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** In-memory ring buffer of log entries, queryable per plugin (used for diagnostics in the manager UI). */
export class LogStore {
  private entries: LogEntry[] = [];
  private listeners = new Set<(e: LogEntry) => void>();
  constructor(
    private readonly capacity = 2000,
    private readonly sink?: (e: LogEntry) => void,
  ) {}

  write(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    this.sink?.(entry);
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch {
        /* ignore */
      }
    }
  }

  logger(source: string): Logger {
    const mk =
      (level: LogLevel) =>
      (message: string, data?: unknown): void =>
        this.write({ level, source, message, time: Date.now(), data });
    return { debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") };
  }

  query(filter: { source?: string; level?: LogLevel } = {}): LogEntry[] {
    return this.entries.filter((e) => (!filter.source || e.source === filter.source) && (!filter.level || e.level === filter.level));
  }

  subscribe(l: (e: LogEntry) => void): Disposable {
    this.listeners.add(l);
    return toDisposable(() => this.listeners.delete(l));
  }

  clear(source?: string): void {
    this.entries = source ? this.entries.filter((e) => e.source !== source) : [];
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
