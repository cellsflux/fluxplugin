import { toDisposable, type Disposable } from "./common.js";

export interface EventContext<P = unknown> {
  /** Concrete event name that was emitted (never a pattern). */
  readonly name: string;
  readonly payload: P;
  /** Plugin / component that emitted the event, when known. */
  readonly source?: string;
  readonly cancelled: boolean;
  /** Stops propagation to lower-priority listeners and flags the emission as cancelled. */
  cancel(): void;
}

export type EventListener<P = unknown> = (payload: P, ctx: EventContext<P>) => void | Promise<void>;

export interface ListenerOptions {
  /** Higher runs first. Default 0. */
  priority?: number;
  once?: boolean;
}

export interface EmitResult {
  cancelled: boolean;
  errors: unknown[];
  delivered: number;
}

interface Entry {
  pattern: string;
  segments: string[];
  listener: EventListener<any>;
  priority: number;
  once: boolean;
  seq: number;
}

export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  if (pattern === name) return true;
  if (!pattern.includes("*")) return false;
  const p = pattern.split(".");
  const n = name.split(".");
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg === "*") {
      // A trailing "*" swallows the remaining segments (>= 1); an inner "*" matches exactly one.
      if (i === p.length - 1) return n.length > i;
      if (n[i] === undefined) return false;
      continue;
    }
    if (n[i] !== seg) return false;
  }
  return p.length === n.length;
}

/**
 * Typed event bus. `M` maps event names to payload types:
 *
 * ```ts
 * const bus = new EventBus<{ "user.created": { id: string } }>();
 * bus.on("user.created", (u) => u.id);
 * bus.on("user.*", (payload, ctx) => ctx.name);
 * ```
 */
export class EventBus<M extends Record<string, any> = Record<string, any>> {
  private entries: Entry[] = [];
  private seq = 0;
  constructor(private readonly onError: (error: unknown, eventName: string, pattern: string) => void = () => {}) {}

  on<K extends keyof M & string>(name: K, listener: EventListener<M[K]>, opts?: ListenerOptions): Disposable;
  on(pattern: string, listener: EventListener<any>, opts?: ListenerOptions): Disposable;
  on(pattern: string, listener: EventListener<any>, opts: ListenerOptions = {}): Disposable {
    const entry: Entry = {
      pattern,
      segments: pattern.split("."),
      listener,
      priority: opts.priority ?? 0,
      once: opts.once ?? false,
      seq: this.seq++,
    };
    this.entries.push(entry);
    return toDisposable(() => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    });
  }

  once<K extends keyof M & string>(name: K, listener: EventListener<M[K]>, opts?: Omit<ListenerOptions, "once">): Disposable;
  once(pattern: string, listener: EventListener<any>, opts?: Omit<ListenerOptions, "once">): Disposable;
  once(pattern: string, listener: EventListener<any>, opts: Omit<ListenerOptions, "once"> = {}): Disposable {
    return this.on(pattern, listener, { ...opts, once: true });
  }

  off(pattern: string, listener: EventListener<any>): void {
    this.entries = this.entries.filter((e) => !(e.pattern === pattern && e.listener === listener));
  }

  listenerCount(pattern?: string): number {
    return pattern ? this.entries.filter((e) => e.pattern === pattern).length : this.entries.length;
  }

  removeAll(): void {
    this.entries = [];
  }

  private matching(name: string): Entry[] {
    return this.entries
      .filter((e) => matchesPattern(e.pattern, name))
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  /** Synchronous emit. Async listeners are started but not awaited (their rejections go to `onError`). */
  emit<K extends keyof M & string>(name: K, payload: M[K], source?: string): EmitResult;
  emit(name: string, payload?: unknown, source?: string): EmitResult;
  emit(name: string, payload?: unknown, source?: string): EmitResult {
    const ctx = this.makeCtx(name, payload, source);
    const result: EmitResult = { cancelled: false, errors: [], delivered: 0 };
    for (const entry of this.matching(name)) {
      if (ctx.cancelled) break;
      if (entry.once) this.removeEntry(entry);
      try {
        const r = entry.listener(payload, ctx);
        result.delivered++;
        if (r && typeof (r as Promise<void>).then === "function") {
          (r as Promise<void>).catch((e) => this.fail(e, name, entry.pattern, result));
        }
      } catch (e) {
        this.fail(e, name, entry.pattern, result);
      }
    }
    result.cancelled = ctx.cancelled;
    return result;
  }

  /** Awaits every listener sequentially (priority order). */
  async emitAsync<K extends keyof M & string>(name: K, payload: M[K], source?: string): Promise<EmitResult>;
  async emitAsync(name: string, payload?: unknown, source?: string): Promise<EmitResult>;
  async emitAsync(name: string, payload?: unknown, source?: string): Promise<EmitResult> {
    const ctx = this.makeCtx(name, payload, source);
    const result: EmitResult = { cancelled: false, errors: [], delivered: 0 };
    for (const entry of this.matching(name)) {
      if (ctx.cancelled) break;
      if (entry.once) this.removeEntry(entry);
      try {
        await entry.listener(payload, ctx);
        result.delivered++;
      } catch (e) {
        this.fail(e, name, entry.pattern, result);
      }
    }
    result.cancelled = ctx.cancelled;
    return result;
  }

  /** Resolves with the payload of the next matching event. */
  waitFor<K extends keyof M & string>(name: K, timeoutMs?: number): Promise<M[K]>;
  waitFor(pattern: string, timeoutMs?: number): Promise<unknown>;
  waitFor(pattern: string, timeoutMs = 0): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const sub = this.once(pattern, (p) => {
        if (t) clearTimeout(t);
        resolve(p);
      });
      const t = timeoutMs > 0 ? setTimeout(() => (sub.dispose(), reject(new Error(`waitFor("${pattern}") timed out`))), timeoutMs) : undefined;
    });
  }

  private removeEntry(e: Entry): void {
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
  }

  private fail(e: unknown, name: string, pattern: string, result: EmitResult): void {
    result.errors.push(e);
    try {
      this.onError(e, name, pattern);
    } catch {
      /* the error handler itself must not break emission */
    }
  }

  private makeCtx(name: string, payload: unknown, source?: string): EventContext<any> & { cancelled: boolean } {
    const ctx = {
      name,
      payload,
      source,
      cancelled: false,
      cancel() {
        ctx.cancelled = true;
      },
    };
    return ctx;
  }
}

