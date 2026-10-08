import { FrameworkError, type Disposable } from "./common.js";
import { Registry } from "./registry.js";
import type { Schema } from "./schema.js";

export type SlotMode = "before" | "after" | "replace" | "append" | "prepend";

export interface SlotContribution<C = unknown> {
  /** Optional id so the contribution can be overridden or inspected. Generated when omitted. */
  id?: string;
  slot: string;
  component: C;
  mode?: SlotMode;
  /** Higher renders first within its group. Default 0. */
  priority?: number;
  /** Evaluated at render time with the slot props. */
  when?: (props: Record<string, unknown>) => boolean;
  /** Props merged into the component props. */
  props?: Record<string, unknown>;
}

export interface ResolvedSlotContribution<C = unknown> extends Required<Pick<SlotContribution<C>, "id" | "slot" | "component" | "mode" | "priority">> {
  props?: Record<string, unknown>;
  owner?: string;
}

export interface ResolvedSlot<C = unknown> {
  /** Everything rendered before the host default content (prepend, then before). */
  before: ResolvedSlotContribution<C>[];
  /** When set, replaces the host default content. */
  replacement?: ResolvedSlotContribution<C>;
  /** Everything rendered after the host default content (after, then append). */
  after: ResolvedSlotContribution<C>[];
}

export class SlotRegistry<C = unknown> extends Registry<ResolvedSlotContribution<C> & { when?: SlotContribution<C>["when"] }> {
  private counter = 0;
  /** Set by the plugin manager to activate plugins declaring `onSlot:<name>`. */
  onSlotRendered?: (slot: string) => void;
  private declared = new Set<string>();

  constructor() {
    super("Slot contribution");
  }

  /** Hosts may declare their slots so typos in plugins are caught early. Declaring is optional. */
  declareSlot(name: string): void {
    this.declared.add(name);
  }

  declaredSlots(): string[] {
    return [...this.declared];
  }

  register(c: SlotContribution<C>, owner?: string, opts: { strict?: boolean } = {}): Disposable {
    if (opts.strict && this.declared.size > 0 && !this.declared.has(c.slot)) {
      throw new FrameworkError(`Unknown UI slot "${c.slot}"`, "FLUX_UNKNOWN_SLOT", owner);
    }
    const id = c.id ?? `${owner ?? "anon"}#${c.slot}#${this.counter++}`;
    const entry = { id, slot: c.slot, component: c.component, mode: c.mode ?? "append", priority: c.priority ?? 0, props: c.props, owner, when: c.when };
    return this.add(`${c.slot}::${id}`, entry, owner);
  }

  resolve(slot: string, props: Record<string, unknown> = {}): ResolvedSlot<C> {
    this.onSlotRendered?.(slot);
    const all = this.list()
      .filter((c) => c.slot === slot && (!c.when || safe(() => c.when!(props))))
      .sort((a, b) => b.priority - a.priority);
    const pick = (mode: SlotMode) => all.filter((c) => c.mode === mode);
    return {
      before: [...pick("prepend"), ...pick("before")],
      replacement: pick("replace")[0],
      after: [...pick("after"), ...pick("append")],
    };
  }

  /** Slots that currently have at least one contribution. */
  activeSlots(): string[] {
    return [...new Set(this.list().map((c) => c.slot))];
  }
}

function safe(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------- extension points */

export interface ExtensionPointDefinition {
  name: string;
  description?: string;
  /** Allowed contribution keys, each optionally validated by a schema applied to every contributed item. */
  contributions: Record<string, Schema<any> | null>;
}

interface PointContribution {
  priority: number;
  value: Record<string, unknown>;
}

/**
 * Declarative extension points: the host says *what* can be extended (`toolbar`, `tabs`, `actions`...),
 * plugins contribute plain data validated against the host's schema. No DOM access, no monkey patching.
 */
export class ExtensionPointRegistry extends Registry<PointContribution & { point: string }> {
  private points = new Map<string, ExtensionPointDefinition>();
  private counter = 0;

  constructor() {
    super("Extension point contribution");
  }

  declare(def: ExtensionPointDefinition): Disposable {
    if (this.points.has(def.name)) throw new FrameworkError(`Extension point "${def.name}" is already declared`, "FLUX_DUPLICATE");
    this.points.set(def.name, def);
    return {
      dispose: () => {
        this.points.delete(def.name);
      },
    };
  }

  definition(name: string): ExtensionPointDefinition | undefined {
    return this.points.get(name);
  }

  declaredPoints(): ExtensionPointDefinition[] {
    return [...this.points.values()];
  }

  contribute(point: string, value: Record<string, unknown>, owner?: string, priority = 0): Disposable {
    const def = this.points.get(point);
    if (!def) throw new FrameworkError(`Unknown extension point "${point}"`, "FLUX_UNKNOWN_EXTENSION_POINT", owner);
    for (const [key, v] of Object.entries(value)) {
      if (!(key in def.contributions)) {
        throw new FrameworkError(`Extension point "${point}" does not accept "${key}" (allowed: ${Object.keys(def.contributions).join(", ")})`, "FLUX_INVALID_CONTRIBUTION", owner);
      }
      const schema = def.contributions[key];
      if (schema) {
        for (const item of Array.isArray(v) ? v : [v]) {
          const r = schema.parse(item, `${point}.${key}`);
          if (!r.ok) throw new FrameworkError(`Invalid contribution to "${point}.${key}": ${r.issues.map((i) => i.message).join("; ")}`, "FLUX_INVALID_CONTRIBUTION", owner);
        }
      }
    }
    return this.add(`${point}::${owner ?? "anon"}::${this.counter++}`, { point, priority, value }, owner);
  }

  /** Merged, priority-ordered items contributed under `key` of `point`. */
  items<T = unknown>(point: string, key: string): T[] {
    return this.list()
      .filter((c) => c.point === point && key in c.value)
      .sort((a, b) => b.priority - a.priority)
      .flatMap((c) => {
        const v = c.value[key];
        return (Array.isArray(v) ? v : [v]) as T[];
      });
  }
}
