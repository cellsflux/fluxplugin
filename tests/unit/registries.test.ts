import { describe, expect, it, vi } from "vitest";
import {
  CommandRegistry,
  EventBus,
  ExtensionPointRegistry,
  HookCancelledError,
  HookSystem,
  MenuRegistry,
  PermissionDeniedError,
  PermissionManager,
  RouteRegistry,
  SlotRegistry,
  StyleRegistry,
  buildDependencyGraph,
  activationOrderFor,
  dependentsOf,
  matchesPattern,
  s,
  validateManifest,
  type PluginManifest,
} from "fluxplugin";

describe("EventBus", () => {
  it("delivers typed events, supports wildcards and unsubscribe", () => {
    const bus = new EventBus<{ "user.created": { id: string } }>();
    const a = vi.fn();
    const b = vi.fn();
    const sub = bus.on("user.created", a);
    bus.on("user.*", b);
    bus.emit("user.created", { id: "1" });
    expect(a).toHaveBeenCalledWith({ id: "1" }, expect.objectContaining({ name: "user.created" }));
    expect(b).toHaveBeenCalledTimes(1);
    sub.dispose();
    bus.emit("user.created", { id: "2" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("matches patterns correctly", () => {
    expect(matchesPattern("user.*", "user.profile.updated")).toBe(true);
    expect(matchesPattern("user.*", "user")).toBe(false);
    expect(matchesPattern("*.created", "user.created")).toBe(true);
    expect(matchesPattern("*.created", "a.b.created")).toBe(false);
    expect(matchesPattern("**", "anything.at.all")).toBe(true);
    expect(matchesPattern("a.b", "a.c")).toBe(false);
  });

  it("honours priority, once and cancellation", () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on("x", () => void order.push("low"), { priority: -1 });
    bus.on("x", (_p, ctx) => (order.push("high"), ctx.cancel()), { priority: 10 });
    const r = bus.emit("x", 1);
    expect(order).toEqual(["high"]);
    expect(r.cancelled).toBe(true);

    const once = vi.fn();
    bus.once("y", once);
    bus.emit("y", 1);
    bus.emit("y", 1);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("isolates listener errors (sync and async)", async () => {
    const onError = vi.fn();
    const bus = new EventBus(onError);
    const ok = vi.fn();
    bus.on("e", () => {
      throw new Error("boom");
    });
    bus.on("e", async () => {
      throw new Error("async boom");
    });
    bus.on("e", ok);
    const r = bus.emit("e", null);
    await new Promise((res) => setTimeout(res, 0));
    expect(ok).toHaveBeenCalled();
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("emitAsync awaits listeners in order", async () => {
    const bus = new EventBus();
    const order: number[] = [];
    bus.on("a", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    bus.on("a", () => void order.push(2), { priority: -5 });
    await bus.emitAsync("a", null);
    expect(order).toEqual([1, 2]);
  });
});

describe("HookSystem", () => {
  it("runs validate → before → exec → transform → after and can modify data", async () => {
    const hooks = new HookSystem();
    const trace: string[] = [];
    hooks.use("validate.user.create", (ctx) => void trace.push("validate"));
    hooks.use<{ name: string }, { id: number; name: string }>("before.user.create", (ctx) => {
      trace.push("before");
      ctx.input = { name: ctx.input.name.trim() };
    });
    hooks.use("transform.user.create", (ctx) => ({ ...ctx.result, extra: true }));
    hooks.use("after.user.create", () => void trace.push("after"));
    const result = await hooks.run("user.create", { name: "  Ada " }, (input) => {
      trace.push("exec");
      return { id: 1, name: input.name };
    });
    expect(result).toEqual({ id: 1, name: "Ada", extra: true });
    expect(trace).toEqual(["validate", "before", "exec", "after"]);
  });

  it("can block operations", async () => {
    const hooks = new HookSystem();
    hooks.use("before.user.delete", (ctx) => ctx.cancel("protected"));
    const exec = vi.fn();
    await expect(hooks.run("user.delete", 1, exec)).rejects.toBeInstanceOf(HookCancelledError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("composes around hooks as an onion by priority", async () => {
    const hooks = new HookSystem();
    const trace: string[] = [];
    hooks.use("around.op", async (_c, next) => (trace.push("outer-in"), await next(), trace.push("outer-out"), undefined as never), { priority: 10 });
    hooks.use("around.op", async (_c, next) => (trace.push("inner-in"), await next(), trace.push("inner-out"), undefined as never), { priority: 0 });
    await hooks.run("op", null, () => void trace.push("exec"));
    expect(trace).toEqual(["outer-in", "inner-in", "exec", "inner-out", "outer-out"]);
  });

  it("swallows errors in `after` hooks but propagates `before` errors", async () => {
    const onError = vi.fn();
    const hooks = new HookSystem(onError);
    hooks.use("after.a", () => {
      throw new Error("x");
    });
    await expect(hooks.run("a", 1, () => 5)).resolves.toBe(5);
    expect(onError).toHaveBeenCalled();
    hooks.use("before.b", () => {
      throw new Error("blocked");
    });
    await expect(hooks.run("b", 1, () => 5)).rejects.toThrow("blocked");
  });

  it("filter pipelines transform values and skip failing filters", async () => {
    const onError = vi.fn();
    const hooks = new HookSystem(onError);
    hooks.use("filter.menu.items", (items: string[]) => [...items, "a"], { priority: 1 });
    hooks.use("filter.menu.items", () => {
      throw new Error("bad filter");
    });
    hooks.use("filter.menu.items", (items: string[]) => items.map((i) => i.toUpperCase()), { priority: -1 });
    expect(await hooks.filter("menu.items", ["x"])).toEqual(["X", "A"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed hook names and cleans up by owner", () => {
    const hooks = new HookSystem();
    expect(() => hooks.use("nonsense" as any, () => {})).toThrow(/Invalid hook name/);
    hooks.use("before.x", () => {}, { owner: "p" });
    expect(hooks.count()).toBe(1);
    hooks.removeByOwner("p");
    expect(hooks.count()).toBe(0);
  });
});

describe("RouteRegistry", () => {
  it("matches static > param > splat and extracts params", () => {
    const r = new RouteRegistry<string>();
    r.register({ path: "/students/:id", component: "detail" }, "p");
    r.register({ path: "/students/new", component: "new" }, "p");
    r.register({ path: "/docs/*", component: "docs" }, "p");
    expect(r.match("/students/new")?.route.definition.component).toBe("new");
    const m = r.match("/students/42");
    expect(m?.route.definition.component).toBe("detail");
    expect(m?.params).toEqual({ id: "42" });
    expect(r.match("/docs/a/b/c")?.params["*"]).toBe("a/b/c");
    expect(r.match("/nope")).toBeUndefined();
  });

  it("supports children, layouts chain, breadcrumbs and lazy routes", () => {
    const r = new RouteRegistry<string>();
    r.register(
      {
        path: "/settings",
        component: "settings",
        meta: { title: "Settings" },
        children: [{ path: "analytics", lazy: async () => ({ default: "lazy" }), meta: { title: "Analytics" } }],
      },
      "p",
    );
    const m = r.match("/settings/analytics")!;
    expect(m.chain.map((c) => c.fullPath)).toEqual(["/settings", "/settings/analytics"]);
    expect(r.breadcrumbs(m).map((b) => b.label)).toEqual(["Settings", "Analytics"]);
    expect(m.route.definition.lazy).toBeTypeOf("function");
  });

  it("runs guards and protected-access checks", async () => {
    const r = new RouteRegistry<string>();
    r.register({ path: "/admin", component: "a", access: "protected" }, "p");
    r.register({ path: "/beta", component: "b", guards: [(c) => (c.host["beta"] ? true : "/home")] }, "p");
    r.register({ path: "/deny", component: "d", guards: [() => false] }, "p");
    expect(await r.checkGuards(r.match("/admin")!, "/admin")).toMatchObject({ allow: false, redirect: "/login" });
    r.guardContext = { isAuthenticated: true, beta: false };
    expect(await r.checkGuards(r.match("/admin")!, "/admin")).toEqual({ allow: true });
    expect(await r.checkGuards(r.match("/beta")!, "/beta")).toMatchObject({ allow: false, redirect: "/home" });
    expect(await r.checkGuards(r.match("/deny")!, "/deny")).toMatchObject({ allow: false });
  });

  it("rejects duplicates and removes routes on dispose / by owner", () => {
    const r = new RouteRegistry<string>();
    const d = r.register({ path: "/a", component: "a" }, "p");
    expect(() => r.register({ path: "/a", component: "a2" }, "p")).toThrow(/already registered/);
    d.dispose();
    expect(r.match("/a")).toBeUndefined();
    r.register({ path: "/b", component: "b" }, "p");
    expect(r.unregisterByOwner("p")).toBe(1);
  });

  it("rejects routes without a component, lazy loader or children", () => {
    const r = new RouteRegistry<string>();
    expect(() => r.register({ path: "/x" }, "p")).toThrow(/needs a component/);
  });
});

describe("Commands & menus", () => {
  it("executes commands, supports palette search and keybindings", async () => {
    const c = new CommandRegistry();
    c.register({ id: "a.run", title: "Run Analytics", category: "Analytics", keybinding: "Mod+Shift+A", execute: (x: number) => x * 2 }, "p");
    expect(await c.execute("a.run", 21)).toBe(42);
    expect(c.palette("analytics").length).toBe(1);
    expect(c.byKeybinding("shift+mod+a")?.id).toBe("a.run");
    await expect(c.execute("missing")).rejects.toThrow(/Unknown command/);
  });

  it("orders menu items per location", () => {
    const m = new MenuRegistry();
    m.register({ id: "b", location: "sidebar", label: "B", order: 2 }, "p");
    m.register({ id: "a", location: "sidebar", label: "A", order: 1 }, "p");
    m.register({ id: "t", location: "toolbar", label: "T" }, "p");
    m.register({ id: "hidden", location: "sidebar", label: "H", when: () => false }, "p");
    expect(m.items("sidebar").map((i) => i.id)).toEqual(["a", "b"]);
    // same id in another location is allowed
    expect(() => m.register({ id: "a", location: "toolbar", label: "A2" }, "p")).not.toThrow();
  });
});

describe("Slots & extension points", () => {
  it("arranges prepend/before/replace/after/append by priority", () => {
    const slots = new SlotRegistry<string>();
    slots.register({ slot: "dash", component: "app", mode: "append" }, "p");
    slots.register({ slot: "dash", component: "pre", mode: "prepend" }, "p");
    slots.register({ slot: "dash", component: "after-hi", mode: "after", priority: 5 }, "p");
    slots.register({ slot: "dash", component: "rep-low", mode: "replace", priority: 1 }, "p");
    slots.register({ slot: "dash", component: "rep-high", mode: "replace", priority: 9 }, "q");
    slots.register({ slot: "dash", component: "hidden", mode: "after", when: () => false }, "p");
    slots.register({ slot: "other", component: "o" }, "p");
    const r = slots.resolve("dash");
    expect(r.before.map((c) => c.component)).toEqual(["pre"]);
    expect(r.replacement?.component).toBe("rep-high");
    expect(r.after.map((c) => c.component)).toEqual(["after-hi", "app"]);
    expect(slots.activeSlots().sort()).toEqual(["dash", "other"]);
  });

  it("validates extension point contributions against host schemas", () => {
    const ep = new ExtensionPointRegistry();
    ep.declare({ name: "dashboard", contributions: { toolbar: s.object({ id: s.string(), label: s.string() }), tabs: null } });
    ep.contribute("dashboard", { toolbar: [{ id: "a", label: "A" }] }, "p", 1);
    ep.contribute("dashboard", { toolbar: [{ id: "b", label: "B" }] }, "q", 5);
    expect(ep.items<{ id: string }>("dashboard", "toolbar").map((i) => i.id)).toEqual(["b", "a"]);
    expect(() => ep.contribute("dashboard", { toolbar: [{ id: 1 }] }, "p")).toThrow(/Invalid contribution/);
    expect(() => ep.contribute("dashboard", { innerHTML: "<script>" }, "p")).toThrow(/does not accept/);
    expect(() => ep.contribute("nope", {}, "p")).toThrow(/Unknown extension point/);
  });
});

describe("StyleRegistry", () => {
  it("orders by priority and removes on dispose", () => {
    const st = new StyleRegistry();
    const d = st.register({ id: "late", css: "a{}", priority: 200 }, "p");
    st.register({ id: "early", css: "b{}", priority: 10 }, "q");
    expect(st.ordered().map((e) => e.id)).toEqual(["early", "late"]);
    d.dispose();
    expect(st.ordered().map((e) => e.id)).toEqual(["early"]);
    expect(() => st.register({}, "p")).toThrow();
  });
});

describe("PermissionManager", () => {
  it("auto-grants declared permissions by default", () => {
    const pm = new PermissionManager();
    pm.declare("p", ["ipc", "network"]);
    expect(pm.has("p", "ipc")).toBe(true);
    expect(pm.has("p", "filesystem.write")).toBe(false);
    expect(() => pm.assert("p", "filesystem.write", "fs.write")).toThrow(PermissionDeniedError);
  });

  it("requires explicit grants when autoGrant is off, and supports revoke", () => {
    const changes: string[] = [];
    const pm = new PermissionManager({ autoGrant: false, onChange: (id) => changes.push(id) });
    pm.declare("p", ["ipc", "network"]);
    expect(pm.has("p", "ipc")).toBe(false);
    pm.grant("p", "ipc");
    expect(pm.has("p", "ipc")).toBe(true);
    expect(pm.snapshot("p").denied).toEqual(["network"]);
    pm.revoke("p", "ipc");
    expect(pm.has("p", "ipc")).toBe(false);
    expect(() => pm.grant("p", "window")).toThrow(/did not declare/);
    expect(changes.length).toBeGreaterThan(0);
  });

  it("restores previously approved grants but drops undeclared ones", () => {
    const pm = new PermissionManager({ autoGrant: false, approved: { p: ["ipc", "window"] } });
    pm.declare("p", ["ipc"]);
    expect(pm.snapshot("p").granted).toEqual(["ipc"]);
  });
});

describe("dependency graph", () => {
  const m = (id: string, version: string, deps: Record<string, string> = {}, extra: Partial<PluginManifest> = {}): PluginManifest => {
    const r = validateManifest({ id, name: id, version, main: "x.js", dependencies: deps, ...extra });
    if (!r.manifest) throw new Error(JSON.stringify(r.issues));
    return r.manifest;
  };

  it("orders dependencies first and computes dependents", () => {
    const g = buildDependencyGraph([m("c.c", "1.0.0", { "b.b": "^1.0.0" }), m("b.b", "1.2.0", { "a.a": "^1.0.0" }), m("a.a", "1.0.0")]);
    expect(g.issues).toEqual([]);
    expect(g.order).toEqual(["a.a", "b.b", "c.c"]);
    expect(activationOrderFor(g, "c.c")).toEqual(["a.a", "b.b", "c.c"]);
    expect(dependentsOf(g, "a.a")).toEqual(["c.c", "b.b"]);
  });

  it("detects missing dependencies, version mismatches and cycles; blocks dependents", () => {
    const g = buildDependencyGraph([
      m("x.x", "1.0.0", { "missing.dep": "^1.0.0" }),
      m("y.y", "1.0.0", { "x.x": "^1.0.0" }),
      m("v.v", "1.0.0", { "w.w": "^2.0.0" }),
      m("w.w", "1.0.0"),
      m("c.one", "1.0.0", { "c.two": "^1.0.0" }),
      m("c.two", "1.0.0", { "c.one": "^1.0.0" }),
      m("ok.ok", "1.0.0"),
    ]);
    const types = g.issues.map((i) => i.type).sort();
    expect(types).toContain("missing");
    expect(types).toContain("version");
    expect(types).toContain("cycle");
    expect([...g.blocked].sort()).toEqual(["c.one", "c.two", "v.v", "x.x", "y.y"]);
    expect(g.order).toEqual(expect.arrayContaining(["ok.ok", "w.w"]));
    expect(g.order).not.toContain("y.y");
  });

  it("treats installed optional dependencies as ordering edges only", () => {
    const g = buildDependencyGraph([m("o.o", "1.0.0", {}, { optionalDependencies: { "n.n": "^1.0.0", "absent.p": "^1.0.0" } }), m("n.n", "1.0.0")]);
    expect(g.issues).toEqual([]);
    expect(g.order).toEqual(["n.n", "o.o"]);
  });
});
