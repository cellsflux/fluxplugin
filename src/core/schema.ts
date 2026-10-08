/**
 * Tiny dependency-free schema library used for manifest validation,
 * IPC input/output validation and plugin configuration.
 * Provides static type inference via `Infer<T>`.
 */
export interface Issue {
  path: string;
  message: string;
}
export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export interface SchemaDescription {
  type: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: readonly unknown[];
  properties?: Record<string, SchemaDescription>;
  required?: string[];
  items?: SchemaDescription;
  optional?: boolean;
  min?: number;
  max?: number;
}

export interface Schema<T> {
  readonly kind: string;
  readonly _type?: T;
  parse(input: unknown, path?: string): ParseResult<T>;
  /** Describes the schema as JSON-schema-like data (used to auto-generate config UIs). */
  describe(): SchemaDescription;
  optional(): Schema<T | undefined>;
  default(value: T): Schema<T>;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;

export class ValidationError extends Error {
  constructor(
    public readonly issues: Issue[],
    what = "value",
  ) {
    super(`Invalid ${what}: ` + issues.map((i) => `${i.path || "<root>"}: ${i.message}`).join("; "));
    this.name = "ValidationError";
  }
}

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (path: string, message: string): ParseResult<never> => ({ ok: false, issues: [{ path, message }] });
const join = (p: string, k: string | number) => (p ? (typeof k === "number" ? `${p}[${k}]` : `${p}.${k}`) : String(k));

function make<T>(
  kind: string,
  parse: (input: unknown, path: string) => ParseResult<T>,
  describe: () => SchemaDescription,
): Schema<T> {
  const self: Schema<T> = {
    kind,
    parse: (input, path = "") => parse(input, path),
    describe,
    optional(): Schema<T | undefined> {
      return make<T | undefined>(
        kind,
        (i, p) => (i === undefined ? ok(undefined) : parse(i, p)),
        () => ({ ...describe(), optional: true }),
      );
    },
    default(value: T): Schema<T> {
      return make<T>(
        kind,
        (i, p) => (i === undefined ? ok(value) : parse(i, p)),
        () => ({ ...describe(), default: value, optional: true }),
      );
    },
  };
  return self;
}

export interface StringOpts {
  min?: number;
  max?: number;
  pattern?: RegExp;
  title?: string;
  description?: string;
}
export interface NumberOpts {
  min?: number;
  max?: number;
  int?: boolean;
  title?: string;
  description?: string;
}

type OptionalKeys<P> = { [K in keyof P]: undefined extends Infer<P[K]> ? K : never }[keyof P];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type ObjectOf<P extends Record<string, Schema<any>>> = Simplify<
  { [K in Exclude<keyof P, OptionalKeys<P>>]: Infer<P[K]> } & { [K in OptionalKeys<P>]?: Exclude<Infer<P[K]>, undefined> }
>;

export const s = {
  string(o: StringOpts = {}): Schema<string> {
    return make<string>(
      "string",
      (i, p) => {
        if (typeof i !== "string") return fail(p, "expected string");
        if (o.min !== undefined && i.length < o.min) return fail(p, `must have at least ${o.min} characters`);
        if (o.max !== undefined && i.length > o.max) return fail(p, `must have at most ${o.max} characters`);
        if (o.pattern && !o.pattern.test(i)) return fail(p, `does not match ${o.pattern}`);
        return ok(i);
      },
      () => ({ type: "string", title: o.title, description: o.description, min: o.min, max: o.max }),
    );
  },
  number(o: NumberOpts = {}): Schema<number> {
    return make<number>(
      "number",
      (i, p) => {
        if (typeof i !== "number" || Number.isNaN(i)) return fail(p, "expected number");
        if (o.int && !Number.isInteger(i)) return fail(p, "expected integer");
        if (o.min !== undefined && i < o.min) return fail(p, `must be >= ${o.min}`);
        if (o.max !== undefined && i > o.max) return fail(p, `must be <= ${o.max}`);
        return ok(i);
      },
      () => ({ type: "number", title: o.title, description: o.description, min: o.min, max: o.max }),
    );
  },
  boolean(o: { title?: string; description?: string } = {}): Schema<boolean> {
    return make<boolean>(
      "boolean",
      (i, p) => (typeof i === "boolean" ? ok(i) : fail(p, "expected boolean")),
      () => ({ type: "boolean", ...o }),
    );
  },
  unknown(): Schema<unknown> {
    return make<unknown>(
      "unknown",
      (i) => ok(i),
      () => ({ type: "unknown" }),
    );
  },
  literal<const V extends string | number | boolean>(v: V): Schema<V> {
    return make<V>(
      "literal",
      (i, p) => (i === v ? ok(v) : fail(p, `expected ${JSON.stringify(v)}`)),
      () => ({ type: "literal", enum: [v] }),
    );
  },
  enum<const V extends readonly string[]>(values: V, o: { title?: string; description?: string } = {}): Schema<V[number]> {
    return make<V[number]>(
      "enum",
      (i, p) =>
        typeof i === "string" && (values as readonly string[]).includes(i)
          ? ok(i as V[number])
          : fail(p, `expected one of ${values.join(", ")}`),
      () => ({ type: "enum", enum: values, ...o }),
    );
  },
  array<T>(item: Schema<T>, o: { min?: number; max?: number } = {}): Schema<T[]> {
    return make<T[]>(
      "array",
      (i, p) => {
        if (!Array.isArray(i)) return fail(p, "expected array");
        if (o.min !== undefined && i.length < o.min) return fail(p, `must have at least ${o.min} items`);
        if (o.max !== undefined && i.length > o.max) return fail(p, `must have at most ${o.max} items`);
        const out: T[] = [];
        const issues: Issue[] = [];
        i.forEach((el, idx) => {
          const r = item.parse(el, join(p, idx));
          if (r.ok) out.push(r.value);
          else issues.push(...r.issues);
        });
        return issues.length ? { ok: false, issues } : ok(out);
      },
      () => ({ type: "array", items: item.describe() }),
    );
  },
  record<T>(value: Schema<T>): Schema<Record<string, T>> {
    return make<Record<string, T>>(
      "record",
      (i, p) => {
        if (typeof i !== "object" || i === null || Array.isArray(i)) return fail(p, "expected object");
        const out: Record<string, T> = {};
        const issues: Issue[] = [];
        for (const [k, v] of Object.entries(i)) {
          const r = value.parse(v, join(p, k));
          if (r.ok) out[k] = r.value;
          else issues.push(...r.issues);
        }
        return issues.length ? { ok: false, issues } : ok(out);
      },
      () => ({ type: "record", items: value.describe() }),
    );
  },
  object<P extends Record<string, Schema<any>>>(
    shape: P,
    o: { strict?: boolean; title?: string; description?: string } = {},
  ): Schema<ObjectOf<P>> {
    return make<ObjectOf<P>>(
      "object",
      (i, p) => {
        if (typeof i !== "object" || i === null || Array.isArray(i)) return fail(p, "expected object");
        const src = i as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        const issues: Issue[] = [];
        for (const [k, sch] of Object.entries(shape)) {
          const r = sch.parse(src[k], join(p, k));
          if (r.ok) {
            if (r.value !== undefined) out[k] = r.value;
          } else issues.push(...r.issues);
        }
        if (o.strict) {
          for (const k of Object.keys(src)) if (!(k in shape)) issues.push({ path: join(p, k), message: "unknown property" });
        }
        return issues.length ? { ok: false, issues } : ok(out as ObjectOf<P>);
      },
      () => {
        const properties: Record<string, SchemaDescription> = {};
        const required: string[] = [];
        for (const [k, sch] of Object.entries(shape)) {
          const d = sch.describe();
          properties[k] = d;
          if (!d.optional) required.push(k);
        }
        return { type: "object", title: o.title, description: o.description, properties, required };
      },
    );
  },
  /** Accepts a value if any of the schemas matches. */
  union<T extends readonly Schema<any>[]>(...options: T): Schema<Infer<T[number]>> {
    return make<Infer<T[number]>>(
      "union",
      (i, p) => {
        for (const opt of options) {
          const r = opt.parse(i, p);
          if (r.ok) return r;
        }
        return fail(p, "does not match any allowed shape");
      },
      () => ({ type: "union" }),
    );
  },
  /** Escape hatch for values that cannot be validated structurally (functions, React components...). */
  custom<T>(check: (v: unknown) => boolean, message = "invalid value"): Schema<T> {
    return make<T>(
      "custom",
      (i, p) => (check(i) ? ok(i as T) : fail(p, message)),
      () => ({ type: "custom" }),
    );
  },
  fn<T = (...args: any[]) => any>(): Schema<T> {
    return s.custom<T>((v) => typeof v === "function", "expected function");
  },
};

export function parseOrThrow<T>(schema: Schema<T>, input: unknown, what?: string): T {
  const r = schema.parse(input);
  if (!r.ok) throw new ValidationError(r.issues, what);
  return r.value;
}
