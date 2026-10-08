// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { s, definePlugin, type PluginDefinition } from "fluxplugin";
import { MainFramework, createLoopbackBridge } from "fluxplugin/main";
import {
  CommandPalette,
  Link,
  PluginProvider,
  PluginRoutes,
  PluginSlot,
  RendererFramework,
  StyleHost,
  Breadcrumbs,
  useExtensionItems,
  useMenu,
  usePluginEvent,
  usePluginIPC,
  usePluginState,
  usePlugins,
  navigate,
  useParams,
  useKeybindings,
  TitleBar,
  ThemeProvider,
  ToastHost,
  declareHostPoints,
} from "fluxplugin/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tmp: string;
let root: Root | undefined;
let container: HTMLElement;
let fw: MainFramework | undefined;
let rf: RendererFramework | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-react-"));
  container = document.createElement("div");
  document.body.appendChild(container);
  window.location.hash = "#/";
});
afterEach(async () => {
  await act(async () => root?.unmount());
  rf?.stop();
  await fw?.stop();
  container.remove();
  document.head.querySelectorAll("[data-flux-style]").forEach((n) => n.remove());
  await fs.rm(tmp, { recursive: true, force: true });
  root = rf = undefined;
  fw = undefined;
});

const PERMS = ["commands", "ipc", "services", "events", "routes", "ui", "menus", "hooks", "styles"];

async function mainPlugin(id: string, mainSrc: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(tmp, "plugins", id);
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", main: "./dist/main.mjs", renderer: "./dist/renderer.js", styles: ["./dist/s.css"], permissions: PERMS, ...extra }),
  );
  await fs.writeFile(path.join(dir, "dist/main.mjs"), mainSrc);
  await fs.writeFile(path.join(dir, "dist/renderer.js"), "export default {}");
  await fs.writeFile(path.join(dir, "dist/s.css"), ".x{}");
}

/** Boots a real main framework + a renderer runtime (renderer entries supplied in-memory by `defs`). */
async function boot(defs: Record<string, PluginDefinition<any>>, ui: React.ReactElement, before?: (rf: RendererFramework) => void) {
  fw = new MainFramework({
    pluginDirs: [path.join(tmp, "plugins")],
    dataDir: path.join(tmp, "data"),
    assetUrl: (id, rel) => `mem://${id}/${rel}`,
    // Under jsdom vite-node intercepts native dynamic imports of file:// URLs (a test-environment artifact; the
    // node-environment tests in main.test.ts exercise the real importer). Evaluate the plugin's `export default` here.
    discover: { loadEntry: async (file) => new Function(((await fs.readFile(file, "utf8")).replace(/^\s*export default/m, "return ")))() },
  });
  await fw.start();
  rf = new RendererFramework({
    bridge: createLoopbackBridge(fw),
    importPlugin: async (url) => {
      const id = url.replace("mem://", "").split("/")[0]!;
      return defs[id] ?? {};
    },
  });
  before?.(rf);
  await act(async () => void (await rf!.start()));
  root = createRoot(container);
  await act(async () => root!.render(<PluginProvider framework={rf!}>{ui}</PluginProvider>));
}
const tick = (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

describe("renderer runtime with a real main process", () => {
  it("renders dynamic routes (static + lazy), nav menu from routes, breadcrumbs and params", async () => {
    await mainPlugin("pages.p", "export default {}");
    const Home = () => <h1>Home</h1>;
    const Detail = () => <h1>Detail {useParams()["id"]}</h1>;
    const Lazy = () => <h1>Lazy page</h1>;
    function Shell() {
      const { items } = useMenu("sidebar");
      return (
        <div>
          <nav>{items.map((i) => <Link key={i.id} to={i.path!}>{i.label}</Link>)}</nav>
          <Breadcrumbs />
          <PluginRoutes />
        </div>
      );
    }
    await boot(
      {
        "pages.p": definePlugin({
          routes: [
            { path: "/", component: Home },
            { path: "/items/:id", component: Detail, meta: { title: "Item", breadcrumb: (p: any) => `Item ${p.id}` } },
            { path: "/lazy", lazy: async () => ({ default: Lazy }), meta: { title: "Lazy", menu: { label: "Lazy page link" } } },
          ],
        }),
      },
      <Shell />,
    );
    await tick();
    expect(container.textContent).toContain("Home");
    expect(container.querySelector("nav a")?.textContent).toBe("Lazy page link");

    await act(async () => navigate("/items/42"));
    await tick();
    expect(container.textContent).toContain("Detail 42");
    expect(container.querySelector(".flux-breadcrumbs")?.textContent).toContain("Item 42");

    await act(async () => navigate("/lazy"));
    await tick(50);
    expect(container.querySelector("h1")?.textContent).toBe("Lazy page");

    await act(async () => navigate("/nowhere"));
    await tick();
    expect(container.textContent).toContain("Page not found");
  });

  it("route guards redirect and block; layouts wrap pages", async () => {
    await mainPlugin("guard.p", "export default {}");
    const Layout = ({ children }: { children: React.ReactNode }) => <section data-testid="layout">{children}</section>;
    await boot(
      {
        "guard.p": definePlugin({
          layouts: { main: Layout },
          routes: [
            { path: "/login", component: () => <h1>Login</h1> },
            { path: "/admin", component: () => <h1>Admin</h1>, access: "protected" },
            { path: "/blocked", component: () => <h1>Never</h1>, guards: [() => false] },
            { path: "/wrapped", component: () => <h1>Wrapped</h1>, layout: "main" },
          ],
        }),
      },
      <PluginRoutes />,
    );
    await act(async () => navigate("/admin"));
    await tick(40);
    expect(window.location.hash).toBe("#/login");
    expect(container.textContent).toContain("Login");
    await act(async () => navigate("/blocked"));
    await tick();
    expect(container.textContent).toContain("Access denied");
    await act(async () => navigate("/wrapped"));
    await tick();
    expect(container.querySelector("[data-testid=layout] h1")?.textContent).toBe("Wrapped");
  });

  it("UI slots: prepend/append/replace and extension-point data, with priorities", async () => {
    await mainPlugin("slots.a", "export default {}");
    await mainPlugin("slots.b", "export default {}");
    function Dashboard() {
      const tools = useExtensionItems<{ id: string; label: string }>("dashboard", "toolbar");
      return (
        <div>
          <ul data-testid="tools">{tools.map((t) => <li key={t.id}>{t.label}</li>)}</ul>
          <PluginSlot name="dashboard.header"><p>host header</p></PluginSlot>
          <PluginSlot name="dashboard.body"><p>host body</p></PluginSlot>
        </div>
      );
    }
    await boot(
      {
        "slots.a": definePlugin({
          components: [
            { slot: "dashboard.header", component: () => <i>A-after</i>, mode: "after" },
            { slot: "dashboard.header", component: () => <i>A-before</i>, mode: "prepend" },
          ],
          extensions: [{ point: "dashboard", contribution: { toolbar: [{ id: "a", label: "Alpha" }] }, priority: 1 }],
        }),
        "slots.b": definePlugin({
          components: [{ slot: "dashboard.body", component: () => <b>B-replaced</b>, mode: "replace" }],
          extensions: [{ point: "dashboard", contribution: { toolbar: [{ id: "b", label: "Beta" }] }, priority: 9 }],
        }),
      },
      <Dashboard />,
      // The host declares which data an extension point accepts *before* plugins start; contributions arrive validated.
      (r) => void r.manager.extensionPoints.declare({ name: "dashboard", contributions: { toolbar: s.object({ id: s.string(), label: s.string() }) } }),
    );
    await tick();
    expect(container.textContent).toContain("A-before");
    expect(container.textContent).toContain("A-after");
    expect(container.textContent).toContain("host header");
    expect(container.textContent).toContain("B-replaced");
    expect(container.textContent).not.toContain("host body");
    expect([...container.querySelectorAll("[data-testid=tools] li")].map((l) => l.textContent)).toEqual(["Beta", "Alpha"]);
    expect(container.textContent!.indexOf("A-before")).toBeLessThan(container.textContent!.indexOf("host header"));
  });

  it("type-safe IPC end to end: renderer → window.plugins → preload spec → main handler; and main → renderer events", async () => {
    await mainPlugin(
      "ipc.p",
      `export default {
         ipc: [{ name: "ipc.p.double", contract: {name:"ipc.p.double"}, handler: ({ n }) => ({ doubled: n * 2 }) }],
         preload: { calc: { double: "ipc.p.double", onTick: { kind: "event", channel: "ipc.p.tick" } } },
         onReady(ctx) { globalThis.__push = (v) => ctx.ipc.send("ipc.p.tick", v); }
       };`,
    );
    function View() {
      const { data, call, error } = usePluginIPC<{ n: number }, { doubled: number }>("ipc.p.double", { caller: "ipc.p" });
      const tick = usePluginEvent<{ v: number }>("ipc.p.tick");
      return (
        <div>
          <button onClick={() => void call({ n: 21 }).catch(() => undefined)}>go</button>
          <span data-testid="out">{data?.doubled ?? "-"}</span>
          <span data-testid="tick">{tick?.v ?? "-"}</span>
          <span data-testid="err">{error?.message ?? ""}</span>
        </div>
      );
    }
    await boot({}, <View />);
    await act(async () => container.querySelector("button")!.click());
    await tick();
    expect(container.querySelector("[data-testid=out]")!.textContent).toBe("42");
    // window.plugins.<ns>.<fn> generated from the preload registry
    const api = (window as any).plugins.calc;
    expect(await api.double({ n: 5 })).toEqual({ doubled: 10 });
    expect(Object.isFrozen((window as any).plugins)).toBe(true);
    // main → renderer push reaches the React hook and the preload event member
    const got: unknown[] = [];
    const off = api.onTick((p: unknown) => got.push(p));
    await act(async () => (globalThis as any).__push({ v: 7 }));
    await tick();
    expect(container.querySelector("[data-testid=tick]")!.textContent).toBe("7");
    expect(got).toEqual([{ v: 7 }]);
    off();
    // channels that were not exposed are unreachable from the renderer
    await expect(rf!.bridge.invoke("not.exposed", {})).rejects.toThrow(/not exposed/);
  });

  it("disabling a plugin from the manager API removes its routes, slots and styles live; enabling brings them back", async () => {
    await mainPlugin("live.p", "export default {}");
    await boot(
      {
        "live.p": definePlugin({
          routes: [{ path: "/live", component: () => <h1>Live</h1> }],
          components: [{ slot: "s", component: () => <em>widget</em> }],
          styles: [".live{color:red}"],
        }),
      },
      <><StyleHost /><PluginSlot name="s" /><PluginRoutes /></>,
    );
    await act(async () => navigate("/live"));
    await tick();
    expect(container.textContent).toContain("Live");
    expect(container.textContent).toContain("widget");
    const styles = () => [...document.head.querySelectorAll("[data-flux-style]")].map((n) => n.getAttribute("data-flux-style"));
    expect(styles().some((x) => x!.startsWith("live.p:"))).toBe(true);
    expect(styles().length).toBe(2); // inline css + manifest stylesheet <link>

    await act(async () => void (await rf!.client.disable("live.p")));
    await tick(60);
    expect(container.textContent).not.toContain("widget");
    expect(container.textContent).toContain("Page not found");
    expect(styles()).toEqual([]);

    await act(async () => void (await rf!.client.enable("live.p")));
    await tick(80);
    expect(container.textContent).toContain("Live");
    expect(container.textContent).toContain("widget");
  });

  it("a crashing plugin component is contained, reported and finally auto-disabled; siblings keep working", async () => {
    await mainPlugin("crash.p", "export default {}");
    await mainPlugin("fine.p", "export default {}");
    const Boom = () => {
      throw new Error("render boom");
    };
    const origError = console.error;
    console.error = () => {};
    try {
      await boot(
        {
          "crash.p": definePlugin({ components: [{ slot: "s", component: Boom }] }),
          "fine.p": definePlugin({ components: [{ slot: "s", component: () => <em>fine</em> }] }),
        },
        <div><PluginSlot name="s"><p>host</p></PluginSlot></div>,
      );
      await tick(40);
      expect(container.textContent).toContain("fine");
      expect(container.textContent).toContain("host");
      expect(container.textContent).toContain("crash.p");
      expect(container.querySelector(".fluxplugin-error")).toBeTruthy();
      expect(rf!.manager.logs.query({ source: "crash.p", level: "error" }).length).toBeGreaterThan(0);
      // Repeated render errors disable the plugin everywhere.
      rf!.reportRenderError("crash.p", new Error("again"));
      rf!.reportRenderError("crash.p", new Error("again"));
      await tick(80);
      expect(fw!.manager.info("crash.p").enabled).toBe(false);
      expect(container.querySelector(".fluxplugin-error")).toBeNull();
      expect(container.textContent).toContain("fine");
    } finally {
      console.error = origError;
    }
  });

  it("usePluginState is shared with ctx.state; usePlugins lists plugins; permissions are mirrored from main", async () => {
    await mainPlugin("state.p", "export default {}", { permissions: ["events", "ui"] });
    let ctxState: any;
    function View() {
      const [count, setCount] = usePluginState("state.p", "count", 0);
      const plugins = usePlugins();
      return (
        <div>
          <button onClick={() => setCount((c) => c + 1)}>inc</button>
          <span data-testid="count">{count}</span>
          <span data-testid="plugins">{plugins.map((p) => `${p.id}:${p.state}`).join(",")}</span>
        </div>
      );
    }
    await boot({ "state.p": definePlugin({ onActivate: (ctx) => void (ctxState = ctx.state) }) }, <View />);
    await tick();
    expect(container.querySelector("[data-testid=plugins]")!.textContent).toBe("state.p:ready");
    await act(async () => container.querySelector("button")!.click());
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("[data-testid=count]")!.textContent).toBe("2");
    expect(ctxState.get("count")).toBe(2);
    act(() => ctxState.set("count", 10));
    expect(container.querySelector("[data-testid=count]")!.textContent).toBe("10");
    expect(rf!.manager.info("state.p").permissions.granted.sort()).toEqual(["events", "ui"]);
  });

  it("revoking a permission in main takes effect for renderer plugins at once", async () => {
    await mainPlugin("perm.p", "export default {}", { permissions: ["commands", "ipc"] });
    await boot({ "perm.p": definePlugin({}) }, <div />);
    const ctx = rf!.manager.contextOf("perm.p")!;
    expect(() => ctx.commands.register({ id: "perm.c", title: "C", execute: () => 1 })).not.toThrow();
    await act(async () => void (await rf!.client.revoke("perm.p", "commands")));
    await act(async () => void (await rf!.sync(true)));
    expect(() => ctx.commands.register({ id: "perm.d", title: "D", execute: () => 1 })).toThrow(/missing permission "commands"/);
  });

  it("command palette lists plugin commands, filters, and runs them (also via keyboard)", async () => {
    await mainPlugin("cmd.p", "export default {}");
    let ran = 0;
    await boot(
      { "cmd.p": definePlugin({ commands: [{ id: "cmd.p.refresh", title: "Refresh Analytics", category: "Analytics", execute: () => void ran++ }, { id: "cmd.p.other", title: "Other", execute: () => {} }] }) },
      <CommandPalette />,
    );
    expect(container.querySelector(".flux-palette")).toBeNull();
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })));
    expect(container.querySelectorAll(".flux-palette-item").length).toBe(2);
    const input = container.querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "refresh");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll(".flux-palette-item").length).toBe(1);
    await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await tick();
    expect(ran).toBe(1);
    expect(container.querySelector(".flux-palette")).toBeNull();
  });

  it("title bar: plugin menus + shortcuts, search providers, notifications (bell + toast), theme switching — with no render loops", async () => {
    await mainPlugin("tb.p", "export default {}", { permissions: [...PERMS, "notifications"] });
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      let ran = 0;
      await boot(
        {
          "tb.p": definePlugin({
            commands: [{ id: "tb.hello", title: "Say hello", keybinding: "Mod+Shift+H", execute: () => void ran++ }],
            menus: [{ id: "tb.menu", location: "application", label: "Tools", order: 5, children: [{ id: "tb.menu.hello", label: "Hello item", command: "tb.hello" }, { id: "tb.sep", label: "", separator: true }] }],
            extensions: [
              { point: "titlebar", contribution: { searchProviders: [{ id: "tb.s", label: "Tools", search: (q: string) => (q === "zed" ? [{ id: "r1", title: "Zed result", run: () => void ran++ }] : []) }] } },
              { point: "theme", contribution: { themes: [{ id: "tb.ocean", label: "Ocean", dark: true, tokens: { "--flux-bg": "#001122" } }] } },
            ],
            onActivate: (ctx) => void ctx.notifications.push({ title: "Plugin ready", level: "success" }),
          }),
        },
        <ThemeProvider><TitleBar title="My App" /><ToastHost /></ThemeProvider>,
        (r) => declareHostPoints(r),
      );
      await tick(60);
      // menu bar
      const topLabels = [...container.querySelectorAll(".flux-menubar > .flux-menu > button")].map((b) => b.textContent);
      expect(topLabels).toEqual(["Tools"]);
      await act(async () => void (container.querySelector(".flux-menubar button") as HTMLElement).click());
      expect(container.querySelector(".flux-dropdown")?.textContent).toContain("Hello item");
      expect(container.querySelector(".flux-dd-item kbd")?.textContent).toMatch(/Ctrl\+Shift\+H|⌘⇧H/);
      await act(async () => void (container.querySelector(".flux-dd-item") as HTMLElement).click());
      expect(ran).toBe(1);
      // notifications: toast + bell badge
      expect(container.querySelector("[data-testid=toasts]")?.textContent).toContain("Plugin ready");
      expect(container.querySelector("[data-testid=bell-count]")?.textContent).toBe("1");
      await act(async () => void (container.querySelector("[data-testid=bell]") as HTMLElement).click());
      expect(container.querySelector(".flux-notif-panel")?.textContent).toContain("Plugin ready");
      expect(container.querySelector("[data-testid=bell-count]")).toBeNull(); // opening marks as read
      // search providers
      const input = container.querySelector("[data-testid=searchbox] input") as HTMLInputElement;
      await act(async () => void input.focus());
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "zed");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await tick(30);
      expect(container.querySelector(".flux-search-results")?.textContent).toContain("Zed result");
      // theme: toggle + plugin theme tokens applied as CSS variables
      const before = document.documentElement.getAttribute("data-theme");
      await act(async () => void (container.querySelector("[data-testid=theme-toggle]") as HTMLElement).click());
      expect(document.documentElement.getAttribute("data-theme")).not.toBe(before);
      const select = container.querySelector(".flux-select") as HTMLSelectElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "tb.ocean");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(document.documentElement.style.getPropertyValue("--flux-bg")).toBe("#001122");
      expect(errors.filter((e) => /Maximum update depth|Warning|Error:/.test(e))).toEqual([]);
    } finally {
      console.error = origError;
      document.documentElement.removeAttribute("data-theme");
      document.documentElement.style.removeProperty("--flux-bg");
    }
  });

  it("Mod+K opens the palette once even when a command is bound to the same shortcut (no double toggle)", async () => {
    await mainPlugin("kb.p", "export default {}");
    function Probe() {
      useKeybindings();
      return <CommandPalette />;
    }
    await boot({ "kb.p": definePlugin({ commands: [{ id: "kb.open", title: "Open palette", keybinding: "Mod+K", execute: () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })) }] }) }, <Probe />);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })));
    await tick(30);
    expect(container.querySelector(".flux-palette")).toBeTruthy();
  });
});
