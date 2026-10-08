import { HookCancelledError, toDisposable, type Disposable } from "./common.js";

export type HookKind = "before" | "after" | "around" | "transform" | "validate" | "filter";
const KINDS: readonly HookKind[] = ["before", "after", "around", "transform", "validate", "filter"];

export interface HookContext<I = any, R = any> {
  /** Operation name without the kind prefix, e.g. `user.create`. */
  readonly operation: string;
  /** Mutable input: `before` hooks may replace or edit it. */
  input: I;
  /** Result of the operation (available to `transform` and `after` hooks). */
  result: R | undefined;
  readonly cancelled: boolean;
  readonly cancelReason: string | undefined;
  /** Aborts the operation; `run()` rejects with `HookCancelledError`. */
  cancel(reason?: string): void;
  /** Shared scratch space between hooks of one run. */
  readonly data: Map<string, unknown>;
}

export type AroundNext<R> = () => Promise<R>;

export type HookHandler<I = any, R = any> =
  // before / validate / after: may return nothing
  | ((ctx: HookContext<I, R>) => void | Promise<void>)
  // transform: returns the new result
  | ((ctx: HookContext<I, R>) => R | Promise<R> | void | Promise<void>)
  // around: middleware
  | ((ctx: HookContext<I, R>, next: AroundNext<R>) => Promise<R> | R)
  // filter: (value, extra) => value
  | ((value: any, extra?: any) => any);

export interface HookOptions {
  priority?: number;
  owner?: string;
}

interface Entry {
  kind: HookKind;
  operation: string;
  handler: (...args: any[]) => any;
  priority: number;
  seq: number;
  owner?: string;
}

function split(name: string): { kind: HookKind; operation: string } {
  const i = name.indexOf(".");
  const kind = (i > 0 ? name.slice(0, i) : "") as HookKind;
  if (!KINDS.includes(kind) || i === name.length - 1) {
    throw new Error(`Invalid hook name "${name}": expected "<${KINDS.join("|")}>.<operation>"`);
  }
  return { kind, operation: name.slice(i + 1) };
}

/**
 * Hook pipeline. Hosts wrap their operations with `run()`; plugins attach behaviours with `use()`.
 *
 * Execution order of `run("user.create", input, exec)`:
 *   validate → before → around (onion) → exec → transform → after
 *
 * `before`/`validate` may mutate `ctx.input`, call `ctx.cancel()` or throw to block the operation.
 * `transform` may replace the result by returning a value. `after` is observational: errors are swallowed
 * (reported through `onError`) so they cannot corrupt an operation that already succeeded.
 */
export class HookSystem {
  private entries: Entry[] = [];
  private seq = 0;
  constructor(private readonly onError: (error: unknown, hookName: string, owner?: string) => void = () => {}) {}

  use<I = any, R = any>(name: `before.${string}` | `after.${string}` | `validate.${string}` | `transform.${string}`, handler: (ctx: HookContext<I, R>) => any, opts?: HookOptions): Disposable;
  use<I = any, R = any>(name: `around.${string}`, handler: (ctx: HookContext<I, R>, next: AroundNext<R>) => any, opts?: HookOptions): Disposable;
  use<V = any, X = any>(name: `filter.${string}`, handler: (value: V, extra?: X) => V | Promise<V>, opts?: HookOptions): Disposable;
  use(name: string, handler: (...args: any[]) => any, opts: HookOptions = {}): Disposable {
    const { kind, operation } = split(name);
    const entry: Entry = { kind, operation, handler, priority: opts.priority ?? 0, seq: this.seq++, owner: opts.owner };
    this.entries.push(entry);
    return toDisposable(() => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    });
  }

  count(kind?: HookKind, operation?: string): number {
    return this.entries.filter((e) => (!kind || e.kind === kind) && (!operation || e.operation === operation)).length;
  }

  list(): { kind: HookKind; operation: string; priority: number; owner?: string }[] {
    return this.entries.map(({ kind, operation, priority, owner }) => ({ kind, operation, priority, owner }));
  }

  private get(kind: HookKind, operation: string): Entry[] {
    return this.entries
      .filter((e) => e.kind === kind && e.operation === operation)
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  async run<I, R>(operation: string, input: I, exec: (input: I, ctx: HookContext<I, R>) => R | Promise<R>): Promise<R> {
    const ctx: HookContext<I, R> & { cancelled: boolean; cancelReason: string | undefined } = {
      operation,
      input,
      result: undefined,
      cancelled: false,
      cancelReason: undefined,
      data: new Map(),
      cancel(reason?: string) {
        ctx.cancelled = true;
        ctx.cancelReason = reason;
      },
    };
    const guard = (): void => {
      if (ctx.cancelled) throw new HookCancelledError(operation, ctx.cancelReason);
    };

    for (const kind of ["validate", "before"] as const) {
      for (const h of this.get(kind, operation)) {
        await h.handler(ctx); // errors thrown here intentionally block the operation
        guard();
      }
    }

    // Onion composition of `around` hooks: highest priority is the outermost layer.
    const arounds = this.get("around", operation);
    const core = async (): Promise<R> => ctx.result = await exec(ctx.input, ctx);
    const composed = arounds.reduceRight<AroundNext<R>>(
      (next, h) => async () => {
        guard();
        const r = await h.handler(ctx, next);
        if (r !== undefined) ctx.result = r as R;
        return ctx.result as R;
      },
      core,
    );
    await composed();
    guard();

    for (const h of this.get("transform", operation)) {
      const r = await h.handler(ctx);
      if (r !== undefined) ctx.result = r as R;
    }

    for (const h of this.get("after", operation)) {
      try {
        await h.handler(ctx);
      } catch (e) {
        this.onError(e, `after.${operation}`, h.owner);
      }
    }
    return ctx.result as R;
  }

  /** Runs `filter.<name>` handlers as a value pipeline. A failing filter is skipped and reported. */
  async filter<V, X = unknown>(name: string, value: V, extra?: X): Promise<V> {
    let current = value;
    for (const h of this.get("filter", name)) {
      try {
        const r = await h.handler(current, extra);
        if (r !== undefined) current = r as V;
      } catch (e) {
        this.onError(e, `filter.${name}`, h.owner);
      }
    }
    return current;
  }

  /** Synchronous variant for render-time filters (async filters are ignored with a reported error). */
  filterSync<V, X = unknown>(name: string, value: V, extra?: X): V {
    let current = value;
    for (const h of this.get("filter", name)) {
      try {
        const r = h.handler(current, extra);
        if (r && typeof r.then === "function") throw new Error("async filter used in filterSync()");
        if (r !== undefined) current = r as V;
      } catch (e) {
        this.onError(e, `filter.${name}`, h.owner);
      }
    }
    return current;
  }

  removeByOwner(owner: string): void {
    this.entries = this.entries.filter((e) => e.owner !== owner);
  }
}
