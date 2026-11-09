// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { API_CHANNELS, FILE_OPEN_EVENT, definePlugin, type FluxBridge, type PluginDefinition } from "fluxplugin";
import { MainFramework, createLoopbackBridge } from "fluxplugin/main";
import {
  AlertProvider, FileOpenHost, I18nProvider, PluginProvider, QuitGuard, RendererFramework, UpdateHost, alertApi, createDesktopClient, declareHostPoints,
  isUpdateDownloading, navigate, useBusy, useI18n, useLocation, usePluginT, useT, useUnsavedChanges,
} from "fluxplugin/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tmp: string;
let root: Root | undefined;
let container: HTMLElement;
let fw: MainFramework | undefined;
let rf: RendererFramework | undefined;
let calls: { ch: string; input: unknown; caller?: string }[];
let overrides: Record<string, (input: unknown) => unknown>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-v4r-"));
  container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.clear();
  calls = [];
  overrides = {};
  window.location.hash = "#/";
  await new Promise((r) => setTimeout(r, 15));
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
  vi.restoreAllMocks();
});

const tick = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const q = (sel: string) => container.ownerDocument.querySelector(sel) as HTMLElement | null;
const click = (sel: string) => act(async () => void q(sel)!.click());
const PERMS = ["commands", "ipc", "services", "events", "routes", "ui", "menus", "hooks", "styles"];

async function mainPlugin(id: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(tmp, "plugins", id);
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id, name: id, version: "1.0.0", main: "./dist/main.mjs", renderer: "./dist/renderer.js", permissions: PERMS, ...extra }));
  await fs.writeFile(path.join(dir, "dist/main.mjs"), "export default {}");
  await fs.writeFile(path.join(dir, "dist/renderer.js"), "export default {}");
}

/** Real main framework + renderer runtime; every bridge call is recorded and some channels can be answered by the test. */
async function boot(defs: Record<string, PluginDefinition<any>>, ui: React.ReactElement, fwOpts: Record<string, unknown> = {}) {
  await fs.mkdir(path.join(tmp, "plugins"), { recursive: true });
  fw = new MainFramework({
    pluginDirs: [path.join(tmp, "plugins")], dataDir: path.join(tmp, "data"), assetUrl: (id, rel) => `mem://${id}/${rel}`, ...fwOpts,
    discover: { loadEntry: async (file) => new Function(((await fs.readFile(file, "utf8")).replace(/^\s*export default/m, "return ")))() },
  });
  await fw.start();
  const real = createLoopbackBridge(fw);
  const bridge: FluxBridge = {
    ...real,
    invoke: (async (ch: string, input?: unknown, caller?: string) => {
      calls.push({ ch, input, caller });
      return overrides[ch] ? overrides[ch]!(input) : real.invoke(ch, input, caller);
    }) as never,
  };
  rf = new RendererFramework({ bridge, importPlugin: async (url) => defs[url.replace("mem://", "").split("/")[0]!] ?? {} });
  declareHostPoints(rf);
  await act(async () => void (await rf!.start()));
  root = createRoot(container);
  await act(async () => root!.render(<PluginProvider framework={rf!}>{ui}</PluginProvider>));
}

describe("in-app alerts replace browser dialogs", () => {
  it("confirm resolves true/false, Escape cancels, alerts queue in order, and window.confirm is never used", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const results: string[] = [];
    function Ask() {
      return (
        <>
          <button data-testid="ask" onClick={async () => results.push(String(await alertApi.confirm({ title: "Delete it?", message: "Really", confirmLabel: "Delete", destructive: true })))}>ask</button>
          <button data-testid="two" onClick={() => { void alertApi.alert({ title: "First" }).then(() => results.push("first-closed")); void alertApi.alert({ title: "Second" }).then(() => results.push("second-closed")); }}>two</button>
          <button data-testid="choose" onClick={async () => results.push(await alertApi.choose({ title: "Pick", buttons: [{ label: "A", value: "a" }, { label: "B", value: "b", variant: "primary" }] }))}>choose</button>
        </>
      );
    }
    await boot({}, <AlertProvider><Ask /></AlertProvider>);
    await click("[data-testid=ask]");
    expect(q("[data-testid=alert]")!.textContent).toContain("Delete it?");
    expect(q("[data-testid=alert-ok]")!.textContent).toBe("Delete");
    expect(q("[data-testid=alert-ok]")!.className).toContain("destructive");
    await click("[data-testid=alert-ok]");
    expect(q("[data-testid=alert]")).toBeNull();
    await click("[data-testid=ask]");
    await click("[data-testid=alert-cancel]");
    await click("[data-testid=ask]");
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(results).toEqual(["true", "false", "false"]);
    await click("[data-testid=two]");
    expect(q("[data-testid=alert]")!.textContent).toContain("First");
    await click("[data-testid=alert-ok]");
    expect(q("[data-testid=alert]")!.textContent).toContain("Second");
    await click("[data-testid=alert-ok]");
    expect(results.slice(3)).toEqual(["first-closed", "second-closed"]);
    await click("[data-testid=choose]");
    await click("[data-testid=alert-b]");
    expect(results.at(-1)).toBe("b");
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe("unsaved changes guard", () => {
  function Form() {
    const [dirty, setDirty] = useState(false);
    useUnsavedChanges(dirty, "Profile form");
    return (<><button data-testid="edit" onClick={() => setDirty(true)}>edit</button><button data-testid="save" onClick={() => setDirty(false)}>save</button></>);
  }
  const Where = () => <span data-testid="where">{useLocation()}</span>;

  it("leaving a screen with unsaved edits asks first (links, router, back button); Keep editing stays, Discard leaves", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    await boot({}, <AlertProvider><Form /><Where /></AlertProvider>);
    await act(async () => navigate("/a"));
    await tick();
    expect(q("[data-testid=where]")!.textContent).toBe("/a"); // not dirty: navigation is immediate
    await click("[data-testid=edit]");
    await act(async () => navigate("/b"));
    await tick();
    expect(window.location.hash).toBe("#/a"); // put back, nothing was lost
    expect(q("[data-testid=where]")!.textContent).toBe("/a");
    expect(q("[data-testid=alert]")!.textContent).toMatch(/Discard your changes\?[\s\S]*Profile form/);
    await click("[data-testid=alert-cancel]"); // Keep editing
    await tick();
    expect(q("[data-testid=where]")!.textContent).toBe("/a");
    // a plain hash change (back button, <a href="#/c">) is guarded the same way
    await act(async () => void (window.location.hash = "#/c"));
    await tick();
    expect(q("[data-testid=alert]")).not.toBeNull();
    expect(window.location.hash).toBe("#/a");
    await click("[data-testid=alert-ok]"); // Discard changes
    await tick();
    expect(window.location.hash).toBe("#/c");
    expect(q("[data-testid=where]")!.textContent).toBe("/c");
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("after saving, navigation is free again", async () => {
    await boot({}, <AlertProvider><Form /><Where /></AlertProvider>);
    await click("[data-testid=edit]");
    await click("[data-testid=save]");
    await act(async () => navigate("/free"));
    await tick();
    expect(q("[data-testid=alert]")).toBeNull();
    expect(q("[data-testid=where]")!.textContent).toBe("/free");
  });
});

describe("quit guard", () => {
  const Busy = () => (useBusy(true, "Exporting report"), null);
  const closeRequested = () => act(async () => { fw!.broadcast("flux.app.closeRequested", {}); await new Promise((r) => setTimeout(r, 30)); });
  const confirmCalls = () => calls.filter((c) => c.ch === "flux.app.confirmClose").map((c) => c.input);
  beforeEach(() => {
    overrides["flux.app.closeAck"] = () => true;
    overrides["flux.app.confirmClose"] = () => true;
  });

  it("closes at once (after acknowledging) when nothing would be lost", async () => {
    await boot({}, <AlertProvider><QuitGuard /></AlertProvider>);
    await closeRequested();
    expect(calls.map((c) => c.ch).filter((c) => c.startsWith("flux.app."))).toEqual(["flux.app.closeAck", "flux.app.confirmClose"]);
    expect(confirmCalls()).toEqual([{ ok: true }]);
    expect(q("[data-testid=alert]")).toBeNull();
  });
  it("lists running actions and unsaved work; Quit anyway confirms, Cancel keeps the window", async () => {
    await boot({}, <AlertProvider><QuitGuard /><Busy /></AlertProvider>);
    await closeRequested();
    expect(q("[data-testid=alert]")!.textContent).toContain("Exporting report (in progress)");
    expect(confirmCalls()).toEqual([]);
    await click("[data-testid=alert-cancel]");
    expect(confirmCalls()).toEqual([{ ok: false, background: false }]);
    await closeRequested();
    await click("[data-testid=alert-quit]");
    expect(confirmCalls().at(-1)).toEqual({ ok: true, background: false });
  });
  it("with an update downloading, the user can keep it going in the background", async () => {
    await boot({}, <AlertProvider><QuitGuard updateDownloading={() => true} /></AlertProvider>);
    await closeRequested();
    expect(q("[data-testid=alert]")!.textContent).toContain("An update is being downloaded");
    await click("[data-testid=alert-background]");
    expect(confirmCalls()).toEqual([{ ok: true, background: true }]);
  });
});

describe("FluxAPI client", () => {
  it("sends each call on its channel, identifying the plugin (or the host)", async () => {
    const seen: { ch: string; input: unknown; caller?: string }[] = [];
    const bridge = { invoke: async (ch: string, input?: unknown, caller?: string) => (seen.push({ ch, input, caller }), "r"), on: () => () => undefined, send: () => undefined, bootstrap: async () => ({}) } as unknown as FluxBridge;
    const host = createDesktopClient(bridge);
    const plug = createDesktopClient(bridge, "a.p");
    await host.notify({ title: "x" });
    await plug.files.read({ id: "f_1" } as never, "base64");
    await plug.files.open();
    await plug.clipboard.writeText("t");
    await plug.shell.openExternal("https://x.y");
    await plug.shortcuts.register("Alt+X");
    await plug.tray.set(null);
    await plug.print({ silent: true });
    expect(seen).toEqual([
      { ch: API_CHANNELS.notify, input: { title: "x" }, caller: undefined },
      { ch: API_CHANNELS.read, input: { ref: { id: "f_1" }, as: "base64" }, caller: "a.p" },
      { ch: API_CHANNELS.open, input: {}, caller: "a.p" },
      { ch: API_CHANNELS.clipWrite, input: { text: "t" }, caller: "a.p" },
      { ch: API_CHANNELS.openExternal, input: { url: "https://x.y" }, caller: "a.p" },
      { ch: API_CHANNELS.shortcutRegister, input: { accelerator: "Alt+X" }, caller: "a.p" },
      { ch: API_CHANNELS.trayset, input: null, caller: "a.p" },
      { ch: API_CHANNELS.print, input: { silent: true }, caller: "a.p" },
    ]);
  });
});

describe("files opened by the OS reach the plugin handlers", () => {
  const ref = (name: string, ext: string, id = "f_1") => ({ id, name, ext, path: "/x/" + name, size: 1, mime: "text/plain" });
  const Where = () => <span data-testid="where">{useLocation()}</span>;
  async function setup(extraUi: React.ReactElement = <></>) {
    await mainPlugin("md.p");
    const imported: string[] = [];
    const Quick = ({ file, onClose }: { file: { name: string }; onClose: () => void }) => <div>Viewing {file.name}<button data-testid="close-modal" onClick={onClose}>x</button></div>;
    const defs = {
      "md.p": definePlugin({
        extensions: [
          { point: "fileHandlers", contribution: { handlers: [
            { id: "edit", title: "Editor", extensions: [".md"], mode: "route", route: "/editor" },
            { id: "quick", title: "Quick view", extensions: ["md"], mode: "modal", component: Quick },
            { id: "csv", title: "Importer", extensions: ["csv"], mode: "import", import: async (f: { name: string }) => void imported.push(f.name) },
            { id: "txt", title: "Text", extensions: ["txt"], mode: "route", route: "/txt" },
          ] } },
        ],
      }),
    };
    overrides[API_CHANNELS.handOver] = () => true;
    overrides[API_CHANNELS.pending] = () => [];
    await boot(defs, <AlertProvider><FileOpenHost /><Where />{extraUi}</AlertProvider>);
    await tick();
    return { imported };
  }
  const open = (r: ReturnType<typeof ref>) => act(async () => { fw!.broadcast(FILE_OPEN_EVENT, { ref: r, source: "os" }); await new Promise((res) => setTimeout(res, 30)); });

  it("one matching handler runs directly: a route opens with the file id, and the plugin is handed the file", async () => {
    await setup();
    await open(ref("a.txt", "txt", "f_9"));
    expect(window.location.hash).toBe("#/txt?file=f_9");
    expect(calls).toContainEqual({ ch: API_CHANNELS.handOver, input: { id: "f_9", pluginId: "md.p" }, caller: undefined });
  });
  it("several handlers → 'Open with…' sheet; a modal handler renders its component; the choice can be remembered per extension", async () => {
    await setup();
    await open(ref("note.md", "md"));
    expect(q("[data-testid=open-with]")!.textContent).toContain("Open “note.md” with…");
    expect(q("[data-testid=open-with-edit]")!.textContent).toContain("Opens a page");
    expect(q("[data-testid=open-with-quick]")!.textContent).toContain("Opens a window");
    await click("[data-testid=open-with-quick]");
    expect(q("[data-testid=file-modal]")!.textContent).toContain("Viewing note.md");
    await click("[data-testid=close-modal]");
    expect(q("[data-testid=file-modal]")).toBeNull();
    await open(ref("again.md", "md", "f_2"));
    q("[data-testid=open-with] input[type=checkbox]")!.click();
    await click("[data-testid=open-with-edit]");
    expect(window.location.hash).toBe("#/editor?file=f_2");
    expect(localStorage.getItem("fluxplugin.openwith.md")).toBe("edit");
    await open(ref("third.md", "md", "f_3")); // remembered: no sheet this time
    expect(q("[data-testid=open-with]")).toBeNull();
    expect(window.location.hash).toBe("#/editor?file=f_3");
  });
  it("an import handler runs silently and reports; a file nobody handles gets a clear alert", async () => {
    const { imported } = await setup();
    await open(ref("data.csv", "csv"));
    expect(imported).toEqual(["data.csv"]);
    expect(q("[data-testid=alert]")!.textContent).toContain("data.csv was imported by Importer");
    await click("[data-testid=alert-ok]");
    await open(ref("movie.mkv", "mkv"));
    expect(q("[data-testid=alert]")!.textContent).toMatch(/No plugin can open this file[\s\S]*mkv/);
  });
  it("files received before the UI was ready are delivered when it starts", async () => {
    await mainPlugin("md.p");
    overrides[API_CHANNELS.handOver] = () => true;
    overrides[API_CHANNELS.pending] = () => [ref("early.txt", "txt", "f_early")];
    await boot({ "md.p": definePlugin({ extensions: [{ point: "fileHandlers", contribution: { handlers: [{ id: "txt", title: "Text", extensions: ["txt"], mode: "route", route: "/txt" }] } }] }) }, <AlertProvider><FileOpenHost /></AlertProvider>);
    await tick(50);
    expect(window.location.hash).toBe("#/txt?file=f_early");
  });
});

describe("plugin translations are prefixed automatically and fall back to the system vocabulary", () => {
  it("system plugins own the shared keys; other plugins' keys live under their id; fr-CA finds fr", async () => {
    await mainPlugin("sys.lang", { isSystem: true });
    await mainPlugin("a.p");
    await mainPlugin("b.p");
    await mainPlugin("c.p");
    const defs = {
      "sys.lang": definePlugin({ extensions: [{ point: "i18n", contribution: { languages: [{ code: "fr", label: "French" }] } }, { point: "i18n", contribution: { messages: [{ locale: "fr", messages: { "plugins.save": "Enregistrer (système)" } }] } }] }),
      "a.p": definePlugin({ extensions: [{ point: "i18n", contribution: { messages: [{ locale: "fr", messages: { save: "Enregistrer", "plugins.save": "HACKED" } }] } }] }),
      "b.p": definePlugin({ extensions: [{ point: "i18n", contribution: { messages: [{ locale: "fr", messages: { save: "Sauver" } }] } }] }),
    };
    function View() {
      const t = useT();
      const a = usePluginT("a.p");
      const b = usePluginT("b.p");
      const c = usePluginT("c.p");
      const { setLocale, locale } = useI18n();
      return (
        <div>
          <button data-testid="fr" onClick={() => setLocale("fr-CA")}>fr</button>
          <span data-testid="loc">{locale}</span>
          <span data-testid="sys">{t("plugins.save", "Save")}</span>
          <span data-testid="global-save">{t("save", "no-global-save")}</span>
          <span data-testid="a">{a("save", "Save")}</span>
          <span data-testid="b">{b("save", "Save")}</span>
          <span data-testid="a-sys">{a("plugins.save", "x")}</span>
          <span data-testid="c-sys">{c("plugins.save", "x")}</span>
          <span data-testid="c-unknown">{c("unknown.key", "fallback text")}</span>
        </div>
      );
    }
    await boot(defs, <I18nProvider><View /></I18nProvider>, { systemPlugins: ["sys.lang"] });
    await tick();
    expect(q("[data-testid=sys]")!.textContent).toBe("Save"); // no language chosen yet: fallbacks
    await click("[data-testid=fr]");
    const text = (id: string) => q(`[data-testid=${id}]`)!.textContent;
    expect(text("loc")).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
    expect(text("sys")).toBe("Enregistrer (système)");
    expect(text("global-save")).toBe("no-global-save"); // a plugin's "save" never becomes a global key
    expect(text("a")).toBe("Enregistrer");
    expect(text("b")).toBe("Sauver");
    expect(text("a-sys")).toBe("HACKED"); // its own namespace…
    expect(text("sys")).toBe("Enregistrer (système)"); // …while the system text is untouched
    expect(text("c-sys")).toBe("Enregistrer (système)"); // a plugin without its own text reuses the system translation
    expect(text("c-unknown")).toBe("fallback text");
  });
});

describe("application update card", () => {
  const state = (over: Record<string, unknown>) => ({ status: "available", current: "1.0.0", latest: "2.0.0", notes: "# 2.0.0\n\n<!-- hidden -->\nNew things", totalBytes: 43359, savedBytes: 1558000, ...over });
  const emit = (s: unknown) => act(async () => { fw!.broadcast("flux.update.state", s); await new Promise((r) => setTimeout(r, 20)); });
  beforeEach(() => void (overrides["flux.update.state"] = () => ({ status: "idle", current: "1.0.0" })));

  it("shows an available update with its size, then progress, then restart; the card can be hidden while downloading", async () => {
    await boot({}, <AlertProvider><UpdateHost /></AlertProvider>);
    await tick();
    expect(q("[data-testid=update-card]")).toBeNull();
    await emit(state({}));
    expect(q("[data-testid=update-card]")!.textContent).toMatch(/Version 2\.0\.0 is available[\s\S]*Download 43 KB only[\s\S]*1\.6 MB already on your computer/);
    await click("[data-testid=update-download]");
    expect(calls.some((c) => c.ch === "flux.update.download")).toBe(true);
    await emit(state({ status: "downloading", progress: { receivedBytes: 50, totalBytes: 100, filesDone: 1, filesTotal: 2 } }));
    expect((q("[data-testid=update-progress]") as HTMLProgressElement).value).toBe(50);
    expect(q("[data-testid=update-card]")!.textContent).toContain("50% · 1 KB of 1 KB · 1/2 files");
    expect(isUpdateDownloading()).toBe(true);
    const hide = [...container.ownerDocument.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Hide"))!;
    await act(async () => void hide.click());
    expect(q("[data-testid=update-card]")).toBeNull(); // hidden, still downloading
    await emit(state({ status: "ready" }));
    expect(q("[data-testid=update-card]")!.textContent).toContain("Version 2.0.0 is ready");
    expect(isUpdateDownloading()).toBe(false);
    await click("[data-testid=update-restart]");
    expect(calls.some((c) => c.ch === "flux.update.restart")).toBe(true);
  });
  it("explains what changed (release notes without the author's hidden comments) and reports errors", async () => {
    await boot({}, <AlertProvider><UpdateHost /></AlertProvider>);
    await emit(state({}));
    const whatsNew = [...container.ownerDocument.querySelectorAll("button")].find((b) => b.textContent === "What's new")!;
    await act(async () => void whatsNew.click());
    expect(q("[data-testid=alert]")!.textContent).toContain("New things");
    expect(q("[data-testid=alert]")!.textContent).not.toContain("hidden");
    await click("[data-testid=alert-ok]");
    await emit(state({ status: "error", error: "update server responded 500" }));
    expect(q("[data-testid=update-card]")!.textContent).toMatch(/Update failed[\s\S]*500/);
  });
  it("an update that needs a new installer offers no Download button", async () => {
    await boot({}, <AlertProvider><UpdateHost /></AlertProvider>);
    await emit(state({ requiresInstaller: "1.5.0" }));
    expect(q("[data-testid=update-needs-installer]")!.textContent).toContain("older than 1.5.0");
    expect(q("[data-testid=update-download]")).toBeNull();
  });
});
