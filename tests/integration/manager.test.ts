import { describe, expect, it, vi } from "vitest";
import {
  MemoryStorageBackend,
  PermissionManager,
  PluginManager,
  ValidationError,
  defineIPC,
  definePlugin,
  defineIpcContract,
  s,
  type PluginDefinition,
  type PluginSource,
  type Runtime,
} from "fluxplugin";

const ALL = ["commands", "routes", "menus", "ui", "ipc", "services", "hooks", "events", "styles"] as const;

function src(
  id: string,
  def: PluginDefinition<any> | (() => PluginDefinition<any> | Promise<PluginDefinition<any>>),
  manifest: Record<string, unknown> = {},
): PluginSource {
  return {
    origin: `test:${id}`,
    manifest: { id, name: id, version: "1.0.0", main: "main.js", renderer: "r.js", permissions: [...ALL], ...manifest },
    load: async () => (typeof def === "function" ? def() : def),
  };
}

function mk(runtime: Runtime = "main", opts: Partial<ConstructorParameters<typeof PluginManager>[0]> = {}) {
  return new PluginManager({ runtime, storage: new MemoryStorageBackend(), timeouts: { activate: 200, load: 200, initialize: 200, ready: 200, deactivate: 200, unload: 200 }, ...opts });
}

describe("lifecycle", () => {
  it("runs every phase in order and ends up ready", async () => {
    const m = mk();
    const trace: string[] = [];
    const states: string[] = [];
    m.events.on("plugin.state", (p: any) => void states.push(p.state));
    m.register(
      src("a.a", {
        onLoad: () => void trace.push("load"),
        onInitialize: () => void trace.push("init"),
        onActivate: () => void trace.push("activate"),
        onReady: () => void trace.push("ready"),
        onDeactivate: () => void trace.push("deactivate"),
        onUnload: () => void trace.push("unload"),
      }),
    );
    expect(m.info("a.a").state).toBe("validated");
    await m.activate("a.a");
    expect(m.info("a.a").state).toBe("ready");
    await m.deactivate("a.a");
    expect(m.info("a.a").state).toBe("deactivated");
    await m.unload("a.a");
    expect(m.info("a.a").state).toBe("unloaded");
    expect(trace).toEqual(["load", "init", "activate", "ready", "deactivate", "unload"]);
    expect(states).toEqual(["loaded", "initialized", "activated", "ready", "deactivated", "unloaded"]);
  });

  it("registers declarative contributions on activate and removes them on deactivate", async () => {
    const m = mk("renderer");
    m.register(
      src("ui.p", {
        routes: [{ path: "/p", component: "Page", meta: { title: "P", menu: { label: "P page" } } }],
        commands: [{ id: "p.run", title: "Run", execute: () => 1 }],
        components: [{ slot: "dash", component: "W" }],
        styles: [".x{color:red}"],
        menus: [{ id: "m", location: "toolbar", label: "M", command: "p.run" }],
      }),
    );
    await m.activate("ui.p");
    expect(m.routes.match("/p")).toBeTruthy();
    expect(m.menus.items("sidebar").map((i) => i.label)).toEqual(["P page"]); // automatic menu from route meta
    expect(m.commands.has("p.run")).toBe(true);
    expect(m.slots.resolve("dash").after).toHaveLength(1);
    expect(m.styles.ordered()).toHaveLength(1);
    expect(m.diagnostics("ui.p").contributions.routes).toBe(1);

    await m.deactivate("ui.p");
    expect(m.routes.match("/p")).toBeUndefined();
    expect(m.menus.items("sidebar")).toHaveLength(0);
    expect(m.commands.has("p.run")).toBe(false);
    expect(m.slots.resolve("dash").after).toHaveLength(0);
    expect(m.styles.ordered()).toHaveLength(0);
  });

  it("applies only runtime-relevant declarative parts (no routes in main, no ipc in renderer)", async () => {
    const def = definePlugin({
      routes: [{ path: "/r", component: "X" }],
      ipc: [defineIPC({ name: "p.ping", handler: () => "pong" })],
    });
    const main = mk("main");
    main.register(src("rt.p", def));
    await main.activate("rt.p");
    expect(main.routes.list()).toHaveLength(0);
    expect(main.ipc.has("p.ping")).toBe(true);

    const rend = mk("renderer");
    rend.register(src("rt.p", def));
    await rend.activate("rt.p");
    expect(rend.routes.list()).toHaveLength(1);
    expect(rend.ipc.has("p.ping")).toBe(false);
  });
});

describe("dependencies", () => {
  it("activates dependencies first and deactivates dependents first", async () => {
    const m = mk();
    const trace: string[] = [];
    const mkDef = (n: string) => ({ onActivate: () => void trace.push(`+${n}`), onDeactivate: () => void trace.push(`-${n}`) });
    m.register(src("c.c", mkDef("c"), { dependencies: { "b.b": "^1.0.0" } }));
    m.register(src("b.b", mkDef("b"), { dependencies: { "a.a": "^1.0.0" } }));
    m.register(src("a.a", mkDef("a")));
    await m.activate("c.c");
    expect(trace).toEqual(["+a", "+b", "+c"]);
    await m.deactivate("a.a");
    expect(trace.slice(3)).toEqual(["-c", "-b", "-a"]);
    expect(m.info("c.c").state).toBe("deactivated");
  });

  it("refuses to activate plugins with missing/mismatched dependencies or cycles", async () => {
    const m = mk();
    m.register(src("x.x", {}, { dependencies: { "nope.nope": "^1.0.0" } }));
    m.register(src("c.one", {}, { dependencies: { "c.two": "^1.0.0" } }));
    m.register(src("c.two", {}, { dependencies: { "c.one": "^1.0.0" } }));
    await expect(m.activate("x.x")).rejects.toThrow(/not installed/);
    await expect(m.activate("c.one")).rejects.toThrow(/cycle/);
  });

  it("an optional dependency that fails does not block its dependent", async () => {
    const m = mk();
    m.register(src("opt.dep", () => { throw new Error("nope"); }));
    m.register(src("main.p", {}, { optionalDependencies: { "opt.dep": "^1.0.0" } }));
    await m.activate("main.p");
    expect(m.info("main.p").state).toBe("ready");
    expect(m.info("opt.dep").state).toBe("error");
  });

  it("a failing required dependency fails the dependent without crashing the manager", async () => {
    const m = mk();
    m.register(src("bad.dep", { onActivate: () => { throw new Error("kaput"); } }));
    m.register(src("needs.bad", {}, { dependencies: { "bad.dep": "^1.0.0" } }));
    await expect(m.activate("needs.bad")).rejects.toThrow(/required dependency/);
    expect(m.info("needs.bad").state).toBe("error");
  });
});

describe("failure isolation", () => {
  it("startup activates healthy plugins even when others crash in any phase", async () => {
    const m = mk();
    m.register(src("crash.load", () => { throw new Error("syntax error in entry"); }));
    m.register(src("crash.activate", { onActivate: () => { throw new Error("boom"); } }));
    m.register(src("crash.init", { onInitialize: () => { throw new Error("init boom"); } }));
    m.register(src("good.one", { commands: [{ id: "good.hello", title: "Hello", execute: () => "hi" }] }));
    await m.startup();
    expect(m.info("good.one").state).toBe("ready");
    expect(m.info("crash.load").state).toBe("error");
    expect(m.info("crash.activate").error?.phase).toBe("activate");
    expect(m.info("crash.init").error?.phase).toBe("initialize");
    expect(await m.commands.execute("good.hello")).toBe("hi");
    expect(m.logs.query({ source: "crash.activate", level: "error" }).length).toBeGreaterThan(0);
  });

  it("a failed activation leaves nothing behind (partial registrations are rolled back)", async () => {
    const m = mk();
    m.register(
      src("partial.p", {
        commands: [{ id: "partial.cmd", title: "x", execute: () => 1 }],
        onActivate(ctx) {
          ctx.services.register("partial.svc", {});
          throw new Error("late failure");
        },
      }),
    );
    await expect(m.activate("partial.p")).rejects.toThrow(/late failure/);
    expect(m.commands.has("partial.cmd")).toBe(false);
    expect(m.services.has("partial.svc")).toBe(false);
  });

  it("enforces phase timeouts", async () => {
    const m = mk();
    m.register(src("slow.p", { onActivate: () => new Promise(() => {}) }));
    await expect(m.activate("slow.p")).rejects.toThrow(/timed out/);
    expect(m.info("slow.p").state).toBe("error");
  });

  it("auto-disables plugins that keep crashing, and can be re-enabled", async () => {
    const m = mk("main", { maxCrashes: 3 });
    let broken = true;
    m.register(src("flaky.p", { onActivate: () => { if (broken) throw new Error("fail"); } }));
    for (let i = 0; i < 3; i++) await m.activate("flaky.p").catch(() => undefined);
    expect(m.info("flaky.p").state).toBe("disabled");
    expect(m.info("flaky.p").enabled).toBe(false);
    await expect(m.activate("flaky.p")).rejects.toThrow(/disabled/);
    broken = false;
    await m.enable("flaky.p");
    expect(m.info("flaky.p").state).toBe("ready");
  });

  it("rejects an invalid manifest without throwing and keeps the reason", async () => {
    const m = mk();
    const info = m.register({ manifest: { id: "BAD ID", name: "x", version: "x" }, load: async () => ({}) });
    expect(info.state).toBe("error");
    expect(info.error?.phase).toBe("validate");
    await expect(m.activate(info.id)).rejects.toThrow();
  });

  it("rejects plugin id mismatch between manifest and entry", async () => {
    const m = mk();
    m.register(src("real.id", { id: "other.id" }));
    await expect(m.activate("real.id")).rejects.toThrow(/mismatch/);
  });

  it("a throwing deactivate hook does not prevent cleanup", async () => {
    const m = mk();
    m.register(src("d.p", { commands: [{ id: "d.cmd", title: "x", execute: () => 1 }], onDeactivate: () => { throw new Error("cleanup bug"); } }));
    await m.activate("d.p");
    await m.deactivate("d.p");
    expect(m.commands.has("d.cmd")).toBe(false);
    expect(m.info("d.p").state).toBe("deactivated");
  });
});

describe("activation events (lazy loading)", () => {
  it("does not load plugins until their activation event fires", async () => {
    const m = mk();
    const load = vi.fn(async () => ({ commands: [{ id: "lazy.run", title: "Lazy", execute: () => "ran" }] }) as PluginDefinition);
    m.register({ manifest: { id: "lazy.p", name: "L", version: "1.0.0", main: "x", permissions: ["commands"], activationEvents: ["onCommand:lazy.run"], contributes: { commands: [{ id: "lazy.run", title: "Lazy" }] } }, load });
    await m.startup();
    expect(load).not.toHaveBeenCalled();
    expect(m.info("lazy.p").state).toBe("validated");
    // The command is visible (palette) before the plugin is loaded, and executing it activates the plugin.
    expect(m.commands.palette().map((c) => c.id)).toContain("lazy.run");
    expect(await m.commands.execute("lazy.run")).toBe("ran");
    expect(load).toHaveBeenCalledTimes(1);
    expect(m.info("lazy.p").state).toBe("ready");
  });

  it("activates on route, service, ipc, event and slot events", async () => {
    const m = mk();
    const mkLazy = (id: string, ev: string, def: PluginDefinition = {}) => m.register(src(id, def, { activationEvents: [ev] }));
    mkLazy("s.p", "onService:thing", { services: { thing: { v: 1 } } });
    mkLazy("i.p", "onIPC:i.hello", { ipc: [defineIPC({ name: "i.hello", handler: () => "hello" })] });
    mkLazy("e.p", "onEvent:boot.*");
    await m.startup();
    expect(m.list().every((p) => p.state === "validated")).toBe(true);
    expect(await m.services.resolveAsync("thing")).toEqual({ v: 1 });
    expect(await m.ipc.invoke("i.hello", undefined)).toBe("hello");
    m.events.emit("boot.done", 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.info("e.p").state).toBe("ready");
  });

  it("activates a plugin on first navigation to one of its routes (renderer)", async () => {
    const m = mk("renderer");
    m.register(src("r.p", { routes: [{ path: "/lazy/:id", component: "X" }] }, { activationEvents: ["onRoute:/lazy/:id"] }));
    await m.startup();
    expect(m.info("r.p").state).toBe("validated");
    expect(m.routes.match("/lazy/1")).toBeUndefined();
    expect((await m.routes.matchAsync("/lazy/1"))?.params).toEqual({ id: "1" });
    expect(m.info("r.p").state).toBe("ready");
  });

  it("activates a plugin when its slot is first rendered (renderer)", async () => {
    const m = mk("renderer");
    m.register(src("slot.p", { components: [{ slot: "dash.header", component: "W" }] }, { activationEvents: ["onSlot:dash.header"] }));
    await m.startup();
    expect(m.slots.resolve("dash.header").after).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.slots.resolve("dash.header").after).toHaveLength(1);
  });

  it("startup activates plugins with onStartup, * or no activation events", async () => {
    const m = mk();
    m.register(src("a.none", {}));
    m.register(src("a.star", {}, { activationEvents: ["*"] }));
    m.register(src("a.start", {}, { activationEvents: ["onStartup"] }));
    m.register(src("a.lazy", {}, { activationEvents: ["onCommand:x"] }));
    await m.startup();
    expect(m.list().filter((p) => p.state === "ready").map((p) => p.id).sort()).toEqual(["a.none", "a.star", "a.start"]);
  });
});

describe("permissions", () => {
  it("denies APIs the plugin did not declare — and rolls the plugin back", async () => {
    const m = mk();
    m.register(src("p.p", { onActivate: (ctx) => void ctx.ipc.handle("p.x", () => 1) }, { permissions: ["commands"] }));
    await expect(m.activate("p.p")).rejects.toThrow(/missing permission "ipc"/);
  });

  it("with autoGrant off, nothing works until the user grants permissions", async () => {
    const permissions = new PermissionManager({ autoGrant: false });
    const m = mk("main", { permissions });
    m.register(src("g.p", { commands: [{ id: "g.c", title: "C", execute: () => 1 }] }, { permissions: ["commands"] }));
    await expect(m.activate("g.p")).rejects.toThrow(/missing permission/);
    permissions.grant("g.p", "commands");
    await m.enable("g.p");
    expect(m.commands.has("g.c")).toBe(true);
    permissions.revoke("g.p", "commands");
    expect(() => m.contextOf("g.p")!.commands.register({ id: "g.d", title: "D", execute: () => 1 })).toThrow(/missing permission/);
  });

  it("gates host APIs behind permissions and scopes them per plugin", async () => {
    const m = mk();
    m.provide<{ who: string }>("fs", ({ pluginId }) => ({ who: pluginId }), "filesystem.read");
    m.register(src("fs.ok", { onActivate: (ctx) => void expect(ctx.host.api<{ who: string }>("fs").who).toBe("fs.ok") }, { permissions: ["filesystem.read"] }));
    m.register(src("fs.no", { onActivate: (ctx) => void ctx.host.api("fs") }, { permissions: [] }));
    await m.activate("fs.ok");
    await expect(m.activate("fs.no")).rejects.toThrow(/filesystem.read/);
    expect(() => m.contextOf("fs.ok")!.host.api("missing")).toThrow(/not provided/);
  });

  it("route permission must be held by the registering plugin", async () => {
    const m = mk("renderer");
    m.register(src("rp.p", { routes: [{ path: "/secret", component: "S", permission: "database" }] }));
    await expect(m.activate("rp.p")).rejects.toThrow(/database/);
  });
});

describe("IPC", () => {
  const Input = s.object({ n: s.number() });
  const Output = s.object({ doubled: s.number() });

  it("validates input and output and enforces caller permission", async () => {
    const m = mk();
    const double = defineIPC({ name: "math.double", input: Input, output: Output, permission: "network", handler: ({ n }) => ({ doubled: n * 2 }) });
    const bad = defineIPC({ name: "math.bad", output: Output, handler: () => ({ nope: 1 }) as never });
    m.register(src("math.p", { ipc: [double, bad] }));
    m.register(src("caller.ok", {}, { permissions: ["ipc", "network"] }));
    m.register(src("caller.no", {}, { permissions: ["ipc"] }));
    await m.startup();

    expect(await m.ipc.invoke("math.double", { n: 4 }, { caller: "caller.ok" })).toEqual({ doubled: 8 });
    await expect(m.ipc.invoke("math.double", { n: "4" }, { caller: "caller.ok" })).rejects.toBeInstanceOf(ValidationError);
    await expect(m.ipc.invoke("math.double", { n: 4 }, { caller: "caller.no" })).rejects.toThrow(/missing permission "network"/);
    await expect(m.ipc.invoke("math.bad", undefined)).rejects.toThrow(/output of "math.bad"/);
    await expect(m.ipc.invoke("nope", undefined)).rejects.toThrow(/No handler/);
  });

  it("plugins can call each other through ctx.ipc.invoke with a shared contract", async () => {
    const contract = defineIpcContract<{ n: number }, { doubled: number }>({ name: "shared.double", input: Input, output: Output });
    const m = mk();
    m.register(src("provider.p", { onActivate: (ctx) => void ctx.ipc.handle(contract, ({ n }) => ({ doubled: n * 2 })) }));
    m.register(src("consumer.p", {}));
    await m.startup();
    const r = await m.contextOf("consumer.p")!.ipc.invoke(contract, { n: 21 });
    expect(r.doubled).toBe(42);
  });

  it("reserves the flux.* namespace and rejects duplicate handlers", async () => {
    const m = mk();
    m.register(src("res.p", { onActivate: (ctx) => void ctx.ipc.handle("flux.hack", () => 1) }));
    await expect(m.activate("res.p")).rejects.toThrow(/reserved/);
    m.register(src("one.p", { ipc: [defineIPC({ name: "dup.x", handler: () => 1 })] }));
    m.register(src("two.p", { ipc: [defineIPC({ name: "dup.x", handler: () => 2 })] }));
    await m.activate("one.p");
    await expect(m.activate("two.p")).rejects.toThrow(/already registered/);
    expect(await m.ipc.invoke("dup.x", undefined)).toBe(1); // first owner untouched
  });

  it("main → renderer push goes through the transport; renderer→main messages reach listeners", async () => {
    const sent: unknown[] = [];
    const m = mk();
    m.ipc.setTransport({ broadcast: (channel, payload) => void sent.push([channel, payload]) });
    const got = vi.fn();
    m.register(src("push.p", { onActivate: (ctx) => { ctx.ipc.on("push.refresh", got); ctx.ipc.send("push.updated", { v: 1 }); } }));
    await m.activate("push.p");
    expect(sent).toEqual([["push.updated", { v: 1 }]]);
    expect(m.ipc.dispatch("push.refresh", "now", { caller: "host" })).toBe(1);
    expect(got).toHaveBeenCalledWith("now", expect.objectContaining({ pluginId: "push.p" }));
    await m.deactivate("push.p");
    expect(m.ipc.dispatch("push.refresh", "now")).toBe(0); // listener removed with the plugin
  });

  it("preload exposures are data-only and validated", async () => {
    const m = mk();
    m.register(src("pl.p", { preload: { analytics: { getStats: "analytics.getStats", onUpdated: { kind: "event", channel: "analytics.updated" } } } }));
    await m.activate("pl.p");
    expect(m.preload.manifest()).toEqual({
      analytics: { getStats: { kind: "invoke", channel: "analytics.getStats" }, onUpdated: { kind: "event", channel: "analytics.updated" } },
    });
    m.register(src("pl.bad", { onActivate: (ctx) => void ctx.preload.expose("__proto__", {}) }));
    await expect(m.activate("pl.bad")).rejects.toThrow(/Invalid preload namespace/);
  });
});

describe("storage & config", () => {
  it("isolates storage per plugin and clones values", async () => {
    const m = mk();
    m.register(src("s.one", {}));
    m.register(src("s.two", {}));
    await m.startup();
    const a = m.contextOf("s.one")!.storage;
    const b = m.contextOf("s.two")!.storage;
    const obj = { list: [1] };
    await a.set("k", obj);
    obj.list.push(2);
    expect(await a.get("k")).toEqual({ list: [1] });
    expect(await b.get("k")).toBeUndefined();
    expect(await b.get("k", "fallback")).toBe("fallback");
    expect(await a.keys()).toEqual(["k"]);
    await a.delete("k");
    expect(await a.get("k")).toBeUndefined();
    await expect(a.set("__proto__", 1)).rejects.toThrow(/reserved/);
  });

  it("serializes concurrent writes without losing updates", async () => {
    const m = mk();
    m.register(src("c.p", {}));
    await m.activate("c.p");
    const st = m.contextOf("c.p")!.storage;
    await Promise.all(Array.from({ length: 25 }, (_, i) => st.set(`k${i}`, i)));
    expect((await st.keys()).length).toBe(25);
  });

  it("config has defaults, validation, reset, change events and migration", async () => {
    const storage = new MemoryStorageBackend();
    const schema = s.object({ enabled: s.boolean().default(true), apiUrl: s.string().default("http://localhost") });
    const m = mk("main", { storage });
    m.register(src("cfg.p", { config: { schema, version: 2, migrate: (old, from) => (from < 2 ? { ...old, apiUrl: String(old["url"] ?? "") } : old) } }));
    await m.activate("cfg.p");
    const cfg = m.contextOf("cfg.p")!.config;
    expect(await cfg.get()).toEqual({ enabled: true, apiUrl: "http://localhost" });
    const seen: unknown[] = [];
    cfg.onChange((n) => void seen.push(n));
    await cfg.set({ enabled: false });
    expect(await cfg.get()).toEqual({ enabled: false, apiUrl: "http://localhost" });
    await expect(cfg.set({ apiUrl: 42 as unknown as string })).rejects.toBeInstanceOf(ValidationError);
    expect((await cfg.get()).enabled).toBe(false); // failed update did not persist
    await cfg.reset();
    expect(seen).toHaveLength(2);
    expect(cfg.describe().properties?.apiUrl?.default).toBe("http://localhost");

    // migration from a v1 payload
    await storage.write("old.p", { __fluxplugin_config__: { version: 1, values: { url: "http://old" } } });
    const m2 = mk("main", { storage });
    m2.register(src("old.p", { config: { schema, version: 2, migrate: (old, from) => (from < 2 ? { ...old, apiUrl: String(old["url"]) } : old) } }));
    await m2.activate("old.p");
    expect((await m2.contextOf("old.p")!.config.get()).apiUrl).toBe("http://old");
  });
});

describe("hot reload, enable/disable and persistence", () => {
  it("reload loads a fresh definition and re-registers contributions", async () => {
    const m = mk();
    let version = 1;
    m.register(src("hr.p", () => ({ commands: [{ id: "hr.v", title: "v", execute: () => version }] })));
    await m.activate("hr.p");
    expect(await m.commands.execute("hr.v")).toBe(1);
    version = 2;
    const reloaded = vi.fn();
    m.events.on("plugin.reloaded", reloaded);
    await m.reload("hr.p");
    expect(m.info("hr.p").state).toBe("ready");
    expect(await m.commands.execute("hr.v")).toBe(2);
    expect(reloaded).toHaveBeenCalled();
  });

  it("disable removes everything and persists; a new manager respects it", async () => {
    let saved: string[] = [];
    const stateStore = { load: async () => saved, save: async (ids: string[]) => void (saved = ids) };
    const m = mk("main", { stateStore });
    await m.init();
    m.register(src("dis.p", { commands: [{ id: "dis.c", title: "c", execute: () => 1 }] }));
    await m.activate("dis.p");
    await m.disable("dis.p");
    expect(m.commands.has("dis.c")).toBe(false);
    expect(saved).toEqual(["dis.p"]);
    await expect(m.activate("dis.p")).rejects.toThrow(/disabled/);

    const m2 = mk("main", { stateStore });
    await m2.init();
    m2.register(src("dis.p", {}));
    expect(m2.info("dis.p").state).toBe("disabled");
    await m2.startup();
    expect(m2.info("dis.p").state).toBe("disabled");
  });

  it("notifies subscribers (for UIs) on state changes", async () => {
    const m = mk();
    const l = vi.fn();
    m.subscribe(l);
    m.register(src("n.p", {}));
    await m.activate("n.p");
    expect(l.mock.calls.length).toBeGreaterThan(3);
    expect(m.version).toBeGreaterThan(3);
  });
});

describe("resilience details", () => {
  it("reload() brings back a plugin whose activation had failed (fix the bug, save, it works)", async () => {
    const m = mk();
    let broken = true;
    m.register(src("fix.p", () => ({ commands: [{ id: "fix.c", title: "c", execute: () => 1 }], onActivate: () => { if (broken) throw new Error("bug"); } })));
    await expect(m.activate("fix.p")).rejects.toThrow(/bug/);
    broken = false;
    await m.reload("fix.p");
    expect(m.info("fix.p").state).toBe("ready");
    expect(m.commands.has("fix.c")).toBe(true);
  });

  it("a declarative extension targeting an unknown point is skipped with a warning, not fatal", async () => {
    const m = mk("renderer");
    m.register(src("ext.p", { extensions: [{ point: "no.such.point", contribution: { toolbar: [] } }], components: [{ slot: "s", component: "C" }] }));
    await m.activate("ext.p");
    expect(m.info("ext.p").state).toBe("ready");
    expect(m.slots.resolve("s").after).toHaveLength(1);
    expect(m.logs.query({ source: "ext.p", level: "warn" })[0]?.message).toMatch(/skipped/);
  });
});

describe("services & hooks through plugins", () => {
  it("shares services across plugins and lets plugins hook operations", async () => {
    const m = mk();
    m.register(src("svc.p", { services: { analytics: { stats: () => ({ n: 3 }) } } }));
    m.register(src("hook.p", { hooks: [{ name: "transform.stats.get", handler: (ctx: any) => ({ ...ctx.result, hooked: true }) }] }));
    await m.startup();
    const svc = m.services.resolve<{ stats(): { n: number } }>("analytics")!;
    const out = await m.hooks.run("stats.get", null, () => svc.stats());
    expect(out).toEqual({ n: 3, hooked: true });
    await m.deactivate("hook.p");
    expect(await m.hooks.run("stats.get", null, () => svc.stats())).toEqual({ n: 3 });
  });

  it("subscriptions pushed by a plugin are disposed on deactivate", async () => {
    const m = mk();
    const dispose = vi.fn();
    m.register(src("sub.p", { onActivate: (ctx) => void ctx.lifecycle.subscriptions.add({ dispose }) }));
    await m.activate("sub.p");
    await m.deactivate("sub.p");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("plugin events are delivered across plugins and cleaned up", async () => {
    const m = mk();
    const got = vi.fn();
    m.register(src("ev.a", { events: [{ name: "student.*", handler: got }] }));
    m.register(src("ev.b", { onActivate: (ctx) => void ctx.events.emit("student.created", { id: 1 }) }));
    await m.activate("ev.a");
    await m.activate("ev.b");
    expect(got).toHaveBeenCalledWith({ id: 1 }, expect.objectContaining({ source: "ev.b" }));
    await m.deactivate("ev.a");
    m.events.emit("student.created", { id: 2 });
    expect(got).toHaveBeenCalledTimes(1);
  });
});
