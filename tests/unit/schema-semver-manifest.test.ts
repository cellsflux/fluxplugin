import { describe, expect, it } from "vitest";
import { compareVersions, isValidRange, parseOrThrow, s, satisfies, validateManifest, ValidationError, type Infer } from "fluxplugin";

describe("schema", () => {
  const user = s.object({
    name: s.string({ min: 2 }),
    age: s.number({ int: true, min: 0 }).optional(),
    role: s.enum(["admin", "user"] as const).default("user"),
    tags: s.array(s.string()).default([]),
  });

  it("parses valid data, applies defaults and infers types", () => {
    const v: Infer<typeof user> = parseOrThrow(user, { name: "Ada" });
    expect(v).toEqual({ name: "Ada", role: "user", tags: [] });
  });

  it("reports precise issue paths", () => {
    const r = user.parse({ name: "A", age: 1.5, tags: [1] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.issues.map((i) => i.path).sort();
      expect(paths).toEqual(["age", "name", "tags[0]"]);
    }
  });

  it("throws ValidationError with parseOrThrow", () => {
    expect(() => parseOrThrow(user, 42, "user")).toThrow(ValidationError);
  });

  it("strict objects reject unknown keys", () => {
    const strict = s.object({ a: s.string() }, { strict: true });
    expect(strict.parse({ a: "x", b: 1 }).ok).toBe(false);
  });

  it("describes schemas for auto-generated forms", () => {
    const d = s.object({ url: s.string({ title: "API URL" }).default("http://x"), on: s.boolean() }).describe();
    expect(d.properties?.url?.default).toBe("http://x");
    expect(d.required).toEqual(["on"]);
  });
});

describe("semver", () => {
  it("compares versions including prereleases", () => {
    expect(compareVersions("1.2.3", "1.10.0")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });

  it.each([
    ["1.2.3", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["1.2.9", "~1.2.0", true],
    ["1.3.0", "~1.2.0", false],
    ["1.5.0", ">=1.2.0 <2.0.0", true],
    ["2.1.0", "1.x || 2.x", true],
    ["3.0.0", "1.x || 2.x", false],
    ["1.0.0", "*", true],
    ["1.0.0-beta.1", "^1.0.0", false],
    ["1.0.0", ">= 1.0.0", true],
  ])("satisfies(%s, %s) = %s", (v, r, expected) => {
    expect(satisfies(v, r)).toBe(expected);
  });

  it("validates ranges", () => {
    expect(isValidRange("^1.0.0")).toBe(true);
    expect(isValidRange("banana")).toBe(false);
  });
});

describe("manifest validation", () => {
  const base = {
    id: "com.example.analytics",
    name: "Analytics",
    version: "1.0.0",
    main: "./dist/main.js",
    engines: { "fluxplugin": "^1.0.0" },
    permissions: ["ipc", "routes"],
  };

  it("accepts a valid manifest and fills defaults", () => {
    const r = validateManifest(base);
    expect(r.ok).toBe(true);
    expect(r.manifest?.activationEvents).toEqual([]);
    expect(r.manifest?.dependencies).toEqual({});
  });

  it("rejects bad ids, versions and unknown permissions", () => {
    const r = validateManifest({ ...base, id: "Bad Id!", version: "one", permissions: ["rm -rf"] });
    expect(r.ok).toBe(false);
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain("id");
    expect(paths).toContain("version");
    expect(paths).toContain("permissions[0]");
  });

  it("allows host-defined x.* permissions", () => {
    expect(validateManifest({ ...base, permissions: ["x.billing.read"] }).ok).toBe(true);
  });

  it("checks engine compatibility against the framework version", () => {
    const r = validateManifest({ ...base, engines: { "fluxplugin": "^2.0.0" } });
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.message).toMatch(/requires framework/);
  });

  it("requires at least one entry point", () => {
    const { main: _main, ...noEntry } = base;
    expect(validateManifest(noEntry).ok).toBe(false);
  });

  it("validates activation events", () => {
    expect(validateManifest({ ...base, activationEvents: ["onCommand:a.b", "onStartup"] }).ok).toBe(true);
    expect(validateManifest({ ...base, activationEvents: ["whenever"] }).ok).toBe(false);
  });

  it("rejects invalid dependency ranges and self dependency", () => {
    expect(validateManifest({ ...base, dependencies: { "a.b": "latest!" } }).ok).toBe(false);
    expect(validateManifest({ ...base, dependencies: { [base.id]: "^1.0.0" } }).ok).toBe(false);
  });

  it("warns when engines is missing", () => {
    const { engines: _e, ...noEngines } = base;
    const r = validateManifest(noEngines);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBe(1);
  });
});
